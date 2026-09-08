/**
 * Auto-wire Slack DMs to a single agent — a Wroughtworks fork modification.
 *
 * Trunk answers only conversations someone has explicitly wired, and escalates an unwired one
 * as an approval card. That is the right default for a personal assistant. It is the wrong
 * default for a *company* agent whose whole job is to be asked things: every colleague's first
 * DM would be declined until an admin approved it, one person at a time, forever.
 *
 * The access argument was weighed rather than waved away. Approving someone here lets them
 * reach anything the agent can reach — its Notion integration, its workspace, its memory. For
 * Klára that set is *already* readable by everyone she would talk to: the same Notion workspace
 * they open in a browser. So the card buys friction, not safety, and friction that only an
 * operator can clear becomes an operator-shaped bottleneck the day the agent is useful.
 *
 * OPT-IN AND NARROW, deliberately:
 *   - does nothing unless SLACK_DM_AUTO_WIRE names an agent group (folder or id)
 *   - direct messages only; group channels still raise a card, because a channel is a room
 *     someone chose to put the agent in and membership there is a real decision
 *   - any failure returns 'card', so a broken interceptor degrades to trunk behaviour rather
 *     than silently swallowing the escalation
 */
import { getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  ensureAgentDestinationForWiring,
  getMessagingGroupAgentByPair,
} from '../db/messaging-groups.js';
import { log } from '../log.js';
import { registerChannelCardInterceptor } from '../modules/permissions/channel-approval.js';
import { resolveWiringDefaults } from './channel-defaults.js';

registerChannelCardInterceptor('slack', async (mg) => {
  const target = process.env.SLACK_DM_AUTO_WIRE?.trim();
  if (!target) return 'card';
  if (mg.is_group) return 'card';

  try {
    const group = (await getAgentGroup(target)) ?? (await getAgentGroupByFolder(target));
    if (!group) {
      log.warn('SLACK_DM_AUTO_WIRE names no agent group — falling back to the approval card', { target });
      return 'card';
    }

    // Idempotent: a redelivered event must not create a second wiring for the same pair.
    const existing = await getMessagingGroupAgentByPair(mg.id, group.id);
    if (existing) return 'handled';

    // Engage semantics come from the channel's own declaration for a DM, not from choices
    // invented here — a DM answers everything, and that is the adapter's business to say.
    const engage = resolveWiringDefaults(mg.instance ?? mg.channel_type, false, group.name, mg.channel_type);

    const mga = {
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mg.id,
      agent_group_id: group.id,
      engage_mode: engage.engage_mode,
      engage_pattern: engage.engage_pattern,
      // 'all', not the card flow's 'known': admitting only the triggering sender is exactly the
      // per-person gate this module exists to remove.
      sender_scope: 'all' as const,
      ignored_message_policy: 'accumulate' as const,
      session_mode: 'shared' as const,
      priority: 0,
      created_at: new Date().toISOString(),
    };
    await createMessagingGroupAgent(mga);
    await ensureAgentDestinationForWiring(mga);
    log.info('Slack DM auto-wired', { messagingGroupId: mg.id, agentGroupId: group.id });
    return 'handled';
  } catch (err) {
    log.error('Slack DM auto-wire failed — falling back to the approval card', { err });
    return 'card';
  }
});
