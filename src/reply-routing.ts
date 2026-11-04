/**
 * Reply-routing guard: a reply stays in the conversation it answers.
 *
 * The address of every outbound message is text the agent writes. The
 * destination ACL in delivery.ts only checks that the target is *wired* to
 * the agent — and wiring a conversation creates that ACL row automatically,
 * so an agent wired to N conversations can post a reply from any of them
 * into any other, including a private channel the sender is not in.
 * Observed in production 2026-11-04: after a context compaction, an agent
 * addressed every reply to a DM into a group channel instead.
 *
 * Rule — a reply to a message from conversation X may go to another
 * conversation only if:
 *   1. X is the operator CLI, or the sender of the answered message holds
 *      owner/admin privilege for this agent group (roles table); or
 *   2. the target is an owner's DM (escalation).
 * Otherwise the reply is delivered to X instead, and the owner is told.
 *
 * Scope: sessions with an origin conversation only. Task sessions, sessions
 * without a messaging group, and agent-to-agent traffic are out of scope
 * (the latter never reaches this guard). A reply with no `in_reply_to` is
 * treated as answering the session's origin with an unprivileged sender —
 * fail closed.
 */
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { isTaskThread } from './db/sessions.js';
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';
import { senderFromRawContent } from './sender-identity.js';
import type { MessagingGroup, Session } from './types.js';

/** The inbound row a reply answers, as read from the session mailbox. */
export interface AnsweredInbound {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  content: string;
}

export type ReplyRouteAllowReason =
  | 'out-of-scope'
  | 'same-conversation'
  | 'operator-cli'
  | 'agent-origin'
  | 'privileged-sender'
  | 'owner-dm';

export type ReplyRouteDecision =
  | { action: 'allow'; reason: ReplyRouteAllowReason }
  | {
      action: 'reroute';
      /** The conversation the reply answers — where it is delivered instead. */
      to: MessagingGroup;
      threadId: string | null;
      senderUserId: string | null;
    };

export async function decideReplyRoute(
  session: Session,
  target: MessagingGroup,
  answered: AnsweredInbound | undefined,
): Promise<ReplyRouteDecision> {
  if (!session.messaging_group_id || isTaskThread(session.thread_id)) {
    return { action: 'allow', reason: 'out-of-scope' };
  }

  if (answered?.channelType === 'cli') return { action: 'allow', reason: 'operator-cli' };
  // A reply to another agent's message: a2a has its own routing and ACL.
  if (answered?.channelType === 'agent') return { action: 'allow', reason: 'agent-origin' };

  const originMg = await getMessagingGroup(session.messaging_group_id);
  if (!originMg) return { action: 'allow', reason: 'out-of-scope' };

  // Which conversation does this reply answer? The inbound row's address when
  // we have it (origin row first, so sibling instances resolve to ours); else
  // the session's origin conversation.
  let answeredMg: MessagingGroup = originMg;
  let answeredThreadId: string | null = session.thread_id;
  if (answered?.channelType && answered.platformId) {
    const sameAsOrigin = originMg.channel_type === answered.channelType && originMg.platform_id === answered.platformId;
    const mg = sameAsOrigin ? originMg : await getMessagingGroupByPlatform(answered.channelType, answered.platformId);
    if (mg) {
      answeredMg = mg;
      answeredThreadId = answered.threadId;
    }
  }

  if (target.id === answeredMg.id) return { action: 'allow', reason: 'same-conversation' };

  const sender = answered ? senderFromRawContent(answered.content, answered.channelType) : null;
  const rolesInstalled = await hasTable(getDb(), 'user_roles');
  if (sender && rolesInstalled && (await hasAdminPrivilege(sender.userId, session.agent_group_id))) {
    return { action: 'allow', reason: 'privileged-sender' };
  }

  if (rolesInstalled && (await isOwnerDm(target.id))) {
    return { action: 'allow', reason: 'owner-dm' };
  }

  return { action: 'reroute', to: answeredMg, threadId: answeredThreadId, senderUserId: sender?.userId ?? null };
}

/**
 * Is this messaging group a DM with an owner? Two sources, because an owner
 * has one DM per bot (each agent is its own Slack app) while `user_dms` is a
 * cold-DM cache holding one row per (user, channel_type):
 *   1. the `user_dms` cache row, and
 *   2. any DM session on that group whose `requester_user_id` (host-set from
 *      the routed sender, never agent-writable) is an owner.
 */
async function isOwnerDm(messagingGroupId: string): Promise<boolean> {
  const db = getDb();
  if (await hasTable(db, 'user_dms')) {
    const cached = await db.get(
      `SELECT 1 FROM user_dms d
         JOIN user_roles r ON r.user_id = d.user_id AND r.role = 'owner' AND r.agent_group_id IS NULL
        WHERE d.messaging_group_id = ? LIMIT 1`,
      messagingGroupId,
    );
    if (cached) return true;
  }
  const viaSession = await db.get(
    `SELECT 1 FROM sessions s
       JOIN messaging_groups m ON m.id = s.messaging_group_id AND m.is_group = 0
       JOIN user_roles r ON r.user_id = s.requester_user_id AND r.role = 'owner' AND r.agent_group_id IS NULL
      WHERE s.messaging_group_id = ? LIMIT 1`,
    messagingGroupId,
  );
  return !!viaSession;
}

/** One-line owner alert. Names conversations only — never the reply's content. */
export function rerouteAlertText(agentName: string, intended: MessagingGroup, deliveredTo: MessagingGroup): string {
  const label = (mg: MessagingGroup): string => mg.name || `${mg.channel_type}/${mg.platform_id}`;
  return (
    `⚠️ ${agentName} addressed a reply from "${label(deliveredTo)}" to "${label(intended)}". ` +
    `Delivered to "${label(deliveredTo)}" instead (reply-routing guard).`
  );
}
