/**
 * Auto-wire Slack conversations to a single agent — a Wroughtworks fork modification.
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
 * TWO SURFACES, TWO SWITCHES, because they are not the same decision:
 *
 *   DMs — SLACK_DM_AUTO_WIRE_<NAME>. Anyone's first DM wires itself. A DM is one named human
 *   talking to an agent built to be asked things, and the reasoning above applies whole.
 *
 *   CHANNELS — SLACK_CHANNEL_AUTO_WIRE_<NAME>, and ONLY on an admin's or owner's @mention.
 *   This module used to refuse channels outright, on the grounds that "a channel is a room
 *   someone chose to put the agent in and membership there is a real decision". That reasoning
 *   was right and is preserved rather than deleted — what changed is the observation that an
 *   **admin's @mention IS that decision**, made by exactly the person who would have clicked
 *   the card, in the room it concerns. A stranger's mention is not, and still raises a card.
 *   So the gate moved from the surface to the sender; it did not come off.
 *
 * WHY THE MENTION IS ENOUGH OF A TRIGGER: the router only escalates an unwired conversation
 * when the message was addressed to the bot (`if (!isMention) return`, router.ts). Ambient
 * channel chatter never reaches this module at all, so "auto-wire on mention" adds no new
 * trigger — it changes the answer given at a seam that already fires on precisely that event.
 *
 * OPT-IN AND NARROW, deliberately:
 *   - PER INSTANCE. One host runs one Slack app per agent (SLACK_INSTANCES), so a single
 *     "which agent owns DMs" setting is wrong the moment there are two: a DM to Agent X would
 *     be wired to whoever that setting happened to name. The target is read per receiving
 *     instance — SLACK_DM_AUTO_WIRE_<NAME> for `slack-<name>`, SLACK_DM_AUTO_WIRE for the
 *     unnamed default app; likewise SLACK_CHANNEL_AUTO_WIRE_<NAME>.
 *   - PER SURFACE. Neither switch implies the other. Leaving the channel key unset restores
 *     this module's original behaviour exactly, which is what makes the change safe to ship.
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
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { resolveWiringDefaults } from './channel-defaults.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../types.js';
import type { InboundEvent } from './adapter.js';

// `.env` is NOT loaded into process.env — the codebase parses it into its own object and
// treats process.env as the FALLBACK (see src/config.ts). Reading process.env alone silently
// returned undefined here, so this interceptor politely did nothing and every DM still raised
// a card. Read the file the same way the rest of the codebase does.
/** `slack-klara` → `SLACK_DM_AUTO_WIRE_KLARA` / `SLACK_CHANNEL_AUTO_WIRE_KLARA`; the default
 *  app → `SLACK_DM_AUTO_WIRE` / `SLACK_CHANNEL_AUTO_WIRE`. */
function autoWireKeyFor(instance: string | undefined, surface: 'DM' | 'CHANNEL'): string {
  const base = `SLACK_${surface}_AUTO_WIRE`;
  if (!instance || instance === 'slack') return base;
  const suffix = instance
    .replace(/^slack-/, '')
    .toUpperCase()
    .replace(/-/g, '_');
  return `${base}_${suffix}`;
}

/** The agent this instance auto-wires this surface to, or undefined when the switch is off. */
function autoWireTarget(instance: string | undefined, surface: 'DM' | 'CHANNEL'): string | undefined {
  const key = autoWireKeyFor(instance, surface);
  const env = readEnvFile([key]);
  return (process.env[key] || env[key])?.trim() || undefined;
}

/**
 * Create the wiring and open the sender gate. Shared by both surfaces so a DM and a channel
 * cannot drift into being wired two subtly different ways.
 *
 * `isGroup` selects the channel's own declared engage semantics — a DM answers everything, a
 * channel answers mentions — because that is the adapter's business to say and not a choice to
 * invent here.
 */
async function wire(mg: MessagingGroup, group: AgentGroup, isGroup: boolean): Promise<void> {
  const engage = resolveWiringDefaults(mg.instance ?? mg.channel_type, isGroup, group.name, mg.channel_type);

  const mga: MessagingGroupAgent = {
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: mg.id,
    agent_group_id: group.id,
    engage_mode: engage.engage_mode,
    engage_pattern: engage.engage_pattern,
    // 'all', not the card flow's 'known': admitting only the triggering sender is exactly the
    // per-person gate this module exists to remove.
    sender_scope: 'all' as const,
    ignored_message_policy: 'accumulate' as const,
    // DMs keep the 'shared' stamp this module has always written — flipping existing installs
    // to the declaration's per-thread shape is a separate, reviewable change and not this one.
    // A CHANNEL takes the declaration, and must: Slack declares group engagement as
    // mention-sticky, and resolveWiringDefaults DOWNGRADES sticky to plain mention unless the
    // wiring honors thread ids. Stamping 'shared' with no threads column would therefore hand
    // back a quietly weaker engagement than the channel declares — she would need re-mentioning
    // for every message in a thread she is already in.
    session_mode: isGroup ? engage.session_mode : ('shared' as const),
    priority: 0,
    ...(isGroup && engage.threads !== null ? { threads: engage.threads } : {}),
    created_at: new Date().toISOString(),
  };
  await createMessagingGroupAgent(mga);
  await ensureAgentDestinationForWiring(mga);

  // TWO GATES, not one. The wiring's sender_scope decides which conversations the agent
  // engages in; the messaging group's unknown_sender_policy separately decides who may speak
  // at all. Wiring alone leaves the second gate shut, and the message is dropped as
  // "unknown sender (decline-and-notify policy)" — wired, and still silent.
  //
  // 'public' on a DM means one named human: the person on the other end of it. On a channel it
  // means everyone in the room, which is the larger grant and was decided deliberately: an
  // agent an admin put in a channel that then answers only some of the people in it is a
  // worse thing to explain than one that answers the room.
  if (mg.unknown_sender_policy !== 'public') {
    await updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
  }
}

/**
 * Replay the message that caused the wiring. Without this the FIRST thing anyone ever says
 * to the agent is silently swallowed — the escalation path drops it and answers only from
 * the next one — so a new colleague's experience of the agent is being ignored.
 *
 * This is the mechanism the router itself documents for the card flow ("replay the event
 * via routeInbound after approval"), used here for an auto-wire instead of an approval.
 *
 * It cannot loop: the wiring is committed before this runs, so the replay finds
 * agentCount > 0 and never reaches the escalation branch again. Imported lazily because
 * the router imports the channel barrel, and a static import would close that cycle.
 */
async function replay(mg: MessagingGroup, event: InboundEvent): Promise<void> {
  try {
    const { routeInbound } = await import('../router.js');
    await routeInbound(event);
  } catch (err) {
    // The wiring stands regardless; only this message is lost, and the next one works.
    log.warn('Slack auto-wire: replay of the triggering message failed', { messagingGroupId: mg.id, err });
  }
}

registerChannelCardInterceptor('slack', async (mg, event, senderUserId) => {
  // Keyed on the RECEIVING instance, not on a single global setting. The router persists that
  // instance on the messaging group precisely so sibling bots cannot absorb each other's
  // traffic; wiring must respect the same boundary.
  const isGroup = mg.is_group === 1;
  const target = autoWireTarget(mg.instance, isGroup ? 'CHANNEL' : 'DM');
  if (!target) return 'card';

  try {
    const group = (await getAgentGroup(target)) ?? (await getAgentGroupByFolder(target));
    if (!group) {
      log.warn('Slack auto-wire target names no agent group — falling back to the approval card', {
        target,
        surface: isGroup ? 'channel' : 'dm',
      });
      return 'card';
    }

    // THE CHANNEL GATE. Putting an agent into a room is a membership decision, so only someone
    // who could have approved the card may make it by mentioning her. Checked against the
    // TARGET group — hasAdminPrivilege also returns true for owners and global admins, so a
    // group-scoped admin can wire their own agent and nobody else's.
    //
    // A null sender (payload carried no usable handle) fails this closed, deliberately: an
    // unidentifiable mention is the one case where "wire it" is least defensible.
    if (isGroup) {
      if (!senderUserId || !(await hasAdminPrivilege(senderUserId, group.id))) {
        log.info('Slack channel auto-wire declined — mention was not from an admin; raising the card', {
          messagingGroupId: mg.id,
          senderUserId,
        });
        return 'card';
      }
    }

    // Idempotent: a redelivered event must not create a second wiring for the same pair.
    const existing = await getMessagingGroupAgentByPair(mg.id, group.id);
    if (existing) return 'handled';

    await wire(mg, group, isGroup);
    log.info(isGroup ? 'Slack channel auto-wired' : 'Slack DM auto-wired', {
      messagingGroupId: mg.id,
      agentGroupId: group.id,
      ...(isGroup ? { wiredBy: senderUserId, channel: mg.name ?? mg.platform_id } : {}),
    });

    await replay(mg, event);
    return 'handled';
  } catch (err) {
    log.error('Slack auto-wire failed — falling back to the approval card', { err });
    return 'card';
  }
});
