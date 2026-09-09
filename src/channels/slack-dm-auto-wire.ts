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
import { readEnvFile } from '../env.js';
import {
  createMessagingGroupAgent,
  ensureAgentDestinationForWiring,
  getMessagingGroupAgentByPair,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { log } from '../log.js';
import { registerChannelCardInterceptor } from '../modules/permissions/channel-approval.js';
import { resolveWiringDefaults } from './channel-defaults.js';

// `.env` is NOT loaded into process.env — the codebase parses it into its own object and
// treats process.env as the FALLBACK (see src/config.ts). Reading process.env alone silently
// returned undefined here, so this interceptor politely did nothing and every DM still raised
// a card. Read the file the same way the rest of the codebase does.
registerChannelCardInterceptor('slack', async (mg, event) => {
  const env = readEnvFile(['SLACK_DM_AUTO_WIRE']);
  const target = (process.env.SLACK_DM_AUTO_WIRE || env.SLACK_DM_AUTO_WIRE)?.trim();
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

    // TWO GATES, not one. The wiring's sender_scope decides which conversations the agent
    // engages in; the messaging group's unknown_sender_policy separately decides who may speak
    // at all. Wiring alone leaves the second gate shut, and the message is dropped as
    // "unknown sender (decline-and-notify policy)" — wired, and still silent.
    //
    // 'public' on a DM means one named human: the person on the other end of it. That is a far
    // narrower grant than it sounds, and it is the whole point of auto-wiring.
    if (mg.unknown_sender_policy !== 'public') {
      await updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
    }
    log.info('Slack DM auto-wired', { messagingGroupId: mg.id, agentGroupId: group.id });

    // Replay the message that caused the wiring. Without this the FIRST thing anyone ever says
    // to the agent is silently swallowed — the escalation path drops it and answers only from
    // the next one — so a new colleague's experience of the agent is being ignored.
    //
    // This is the mechanism the router itself documents for the card flow ("replay the event
    // via routeInbound after approval"), used here for an auto-wire instead of an approval.
    //
    // It cannot loop: the wiring above is committed before this runs, so the replay finds
    // agentCount > 0 and never reaches the escalation branch again. Imported lazily because
    // the router imports the channel barrel, and a static import would close that cycle.
    try {
      const { routeInbound } = await import('../router.js');
      await routeInbound(event);
    } catch (err) {
      // The wiring stands regardless; only this message is lost, and the next one works.
      log.warn('Slack DM auto-wire: replay of the triggering message failed', { messagingGroupId: mg.id, err });
    }
    return 'handled';
  } catch (err) {
    log.error('Slack DM auto-wire failed — falling back to the approval card', { err });
    return 'card';
  }
});
