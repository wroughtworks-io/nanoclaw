/**
 * Nightly routing check — verifies the reply-routing guard on real traffic.
 *
 * Replays decideReplyRoute (the guard's own rule, so the check cannot drift
 * from it) over every reply delivered since `since`, and cross-checks the
 * host log: a reply the rule says must be rerouted, with no matching
 * "Cross-conversation reply rerouted to origin" warning, means it was
 * delivered by a path that bypassed the guard — the one thing a runtime guard
 * cannot report about itself. Read-only on every database.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { getDb } from './db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from './db/messaging-groups.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { decideReplyRoute, type AnsweredInbound } from './reply-routing.js';
import type { MessagingGroup, Session } from './types.js';

export const REROUTE_LOG_MESSAGE = 'Cross-conversation reply rerouted to origin';

export interface RoutingCheckReport {
  since: string;
  delivered: number;
  /** Cross-conversation deliveries the rule allows, by reason. */
  allowed: Record<string, number>;
  /** Replies the guard rerouted (log warning present). */
  rerouted: Array<{ id: string; agent: string; from: string; intended: string }>;
  /** Replies the rule says must be rerouted, with no reroute in the log — guard bypassed. */
  bypassed: Array<{ id: string; agent: string; from: string; intended: string }>;
}

/** Ids of messages the host logged as rerouted (any log format that carries id="…"). */
export function reroutedIdsFromLog(logText: string): Set<string> {
  const ids = new Set<string>();
  for (const line of logText.split('\n')) {
    if (!line.includes(REROUTE_LOG_MESSAGE)) continue;
    const m = line.match(/\bid[=:]\s*"?([^"\s,}]+)"?/);
    if (m) ids.add(m[1]!);
  }
  return ids;
}

const label = (mg: MessagingGroup | undefined): string =>
  mg ? mg.name || `${mg.channel_type}/${mg.platform_id}` : '?';

export async function runRoutingCheck(opts: {
  since: string;
  rerouteLogIds: Set<string>;
}): Promise<RoutingCheckReport> {
  const db = getDb();
  const agents = new Map(
    (await db.all<{ id: string; name: string }>('SELECT id, name FROM agent_groups')).map((a) => [a.id, a.name]),
  );
  const report: RoutingCheckReport = { since: opts.since, delivered: 0, allowed: {}, rerouted: [], bypassed: [] };

  for (const session of await db.all<Session>('SELECT * FROM sessions')) {
    const inPath = inboundDbPath(session.agent_group_id, session.id);
    const outPath = outboundDbPath(session.agent_group_id, session.id);
    if (!fs.existsSync(inPath) || !fs.existsSync(outPath)) continue;
    const inbound = new Database(inPath, { readonly: true, fileMustExist: true });
    const outbound = new Database(outPath, { readonly: true, fileMustExist: true });
    try {
      const deliveredIds = new Set(
        (
          inbound
            .prepare(
              "SELECT message_out_id FROM delivered WHERE status = 'delivered' AND datetime(delivered_at) >= datetime(?)",
            )
            .all(opts.since) as Array<{ message_out_id: string }>
        ).map((r) => r.message_out_id),
      );
      if (deliveredIds.size === 0) continue;
      const getAnswered = inbound.prepare(
        'SELECT channel_type AS channelType, platform_id AS platformId, thread_id AS threadId, content FROM messages_in WHERE id = ?',
      );
      const rows = outbound
        .prepare(
          "SELECT id, platform_id, channel_type, in_reply_to FROM messages_out WHERE kind NOT IN ('system','task_log') AND channel_type IS NOT NULL AND channel_type != 'agent'",
        )
        .all() as Array<{ id: string; platform_id: string | null; channel_type: string; in_reply_to: string | null }>;
      const agent = agents.get(session.agent_group_id) ?? session.agent_group_id;
      const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;

      for (const row of rows) {
        if (!deliveredIds.has(row.id) || !row.platform_id) continue;
        report.delivered++;
        // Resolve the written address the way deliverMessage does.
        const target =
          origin && origin.channel_type === row.channel_type && origin.platform_id === row.platform_id
            ? origin
            : ((await getMessagingGroupForOwnDestination(session.agent_group_id, row.channel_type, row.platform_id)) ??
              (await getMessagingGroupByPlatform(row.channel_type, row.platform_id)));
        if (!target) continue;
        const answered = row.in_reply_to
          ? (getAnswered.get(row.in_reply_to) as AnsweredInbound | undefined)
          : undefined;
        const decision = await decideReplyRoute(session, target, answered);
        if (decision.action === 'allow') {
          if (decision.reason !== 'same-conversation' && decision.reason !== 'out-of-scope') {
            report.allowed[decision.reason] = (report.allowed[decision.reason] ?? 0) + 1;
          }
          continue;
        }
        const entry = { id: row.id, agent, from: label(decision.to), intended: label(target) };
        (opts.rerouteLogIds.has(row.id) ? report.rerouted : report.bypassed).push(entry);
      }
    } finally {
      inbound.close();
      outbound.close();
    }
  }
  return report;
}

/** The owner-facing text: null when there is nothing to report and no heartbeat is due. */
export function formatRoutingCheck(report: RoutingCheckReport, env: string, heartbeat: boolean): string | null {
  const allowed = Object.entries(report.allowed)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const lines: string[] = [];
  for (const b of report.bypassed) {
    lines.push(`🚨 ${b.agent}: reply ${b.id} answered "${b.from}" but went to "${b.intended}" — guard bypassed`);
  }
  for (const r of report.rerouted) {
    lines.push(`↩︎ ${r.agent}: reply ${r.id} addressed to "${r.intended}" was kept in "${r.from}"`);
  }
  if (lines.length > 0) {
    return [`Routing check (${env}, since ${report.since}): ${report.delivered} replies`, ...lines].join('\n');
  }
  if (!heartbeat) return null;
  return `Routing check (${env}): OK — ${report.delivered} replies in the last period, 0 problems${allowed ? ` (allowed cross-posts: ${allowed})` : ''}.`;
}
