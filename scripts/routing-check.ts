/**
 * Nightly routing check (see src/routing-check.ts). Read-only on all DBs.
 *
 *   pnpm exec tsx scripts/routing-check.ts --env staging              # print the report
 *   pnpm exec tsx scripts/routing-check.ts --env staging --notify     # + DM the owner when needed
 *
 * --notify DMs every owner (their cached Slack DM, through that DM's own bot)
 * only when something needs a look — a rerouted reply, or one that bypassed
 * the guard — and on Mondays a one-line "OK" heartbeat, so silence means
 * "nothing happened" rather than "the check stopped". --hours sets the
 * window (default 24). --not-before <ISO> floors the window: deliveries made
 * before the guard was running on this box cannot have been rerouted, and
 * would otherwise read as "guard bypassed". Exit 1 when a notification could
 * not be sent.
 */
import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import { readEnvFile } from '../src/env.js';
import { formatRoutingCheck, reroutedIdsFromLog, runRoutingCheck } from '../src/routing-check.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const env = arg('--env') ?? 'unknown';
const hours = Number(arg('--hours') ?? '24');
const notify = process.argv.includes('--notify');
const heartbeat = process.argv.includes('--heartbeat') || new Date().getDay() === 1;

await initDb(CENTRAL_DB_PATH, { role: 'tool' });
const windowStart = Date.now() - hours * 3600_000;
const notBefore = arg('--not-before') ? Date.parse(arg('--not-before')!) : NaN;
if (arg('--not-before') && Number.isNaN(notBefore)) {
  console.error(`--not-before is not a timestamp: ${arg('--not-before')}`);
  process.exit(2);
}
const since = new Date(Number.isNaN(notBefore) ? windowStart : Math.max(windowStart, notBefore)).toISOString();

let logText = '';
for (const f of ['nanoclaw.log', 'nanoclaw.error.log']) {
  const p = path.join('logs', f);
  if (fs.existsSync(p)) logText += fs.readFileSync(p, 'utf8') + '\n';
}
const report = await runRoutingCheck({ since, rerouteLogIds: reroutedIdsFromLog(logText) });
console.log(JSON.stringify({ ...report, rerouted: report.rerouted.length, bypassed: report.bypassed.length }));

const text = formatRoutingCheck(report, env, heartbeat);
if (!text) process.exit(0);
console.log(text);
if (!notify) process.exit(0);

// Owner DMs: user_dms cache rows of global owners (one per owner per platform).
const targets = await getDb().all<{ platform_id: string; instance: string | null }>(
  `SELECT m.platform_id, m.instance FROM user_dms d
     JOIN user_roles r ON r.user_id = d.user_id AND r.role = 'owner' AND r.agent_group_id IS NULL
     JOIN messaging_groups m ON m.id = d.messaging_group_id
    WHERE m.channel_type = 'slack'`,
);
if (targets.length === 0) {
  console.error('No owner Slack DM found — cannot notify');
  process.exit(1);
}
let failed = 0;
for (const t of targets) {
  // Same key scheme as slackInstanceBridgeFactory: instance "slack-klara" → SLACK_BOT_TOKEN_KLARA.
  const name = (t.instance ?? 'slack').replace(/^slack-?/, '');
  const key = name ? `SLACK_BOT_TOKEN_${name.toUpperCase().replace(/-/g, '_')}` : 'SLACK_BOT_TOKEN';
  const token = readEnvFile([key])[key];
  if (!token) {
    console.error(`No ${key} — cannot notify via ${t.instance}`);
    failed++;
    continue;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: t.platform_id.replace(/^slack:/, ''), text }),
  });
  const body = (await res.json()) as { ok?: boolean; error?: string };
  if (!body.ok) {
    console.error(`chat.postMessage failed via ${t.instance}: ${body.error}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
