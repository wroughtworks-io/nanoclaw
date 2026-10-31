/**
 * Per-person memory module (decision 0026) — the two system actions the
 * container tools write. The logic and the checks live in
 * src/person-memory.ts; the router resolves the person's reply there too.
 *
 *   person_memory_propose → hold the item, ask the person in their DM.
 *   person_memory_forget  → remove items from the person's own memory.
 *
 * Unguarded: neither action stores anything the person has not approved.
 * A proposal is only held; the store happens on the person's yes, judged by
 * host code. A forget only removes, and the host announces it to the person.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/types.js';
import { forgetOnRequest, MAX_ITEM_LEN, MAX_ITEMS, proposeItem } from '../../person-memory.js';
import { notifyAgent } from '../approvals/index.js';

const REFUSALS: Record<string, string> = {
  not_a_dm: 'person memory exists only in a 1:1 DM with one person; nothing was proposed.',
  disabled: 'person memory is not enabled for this agent; nothing was proposed.',
  empty: 'the proposed text was empty; nothing was proposed.',
  too_long: `the proposed text is longer than ${MAX_ITEM_LEN} characters; shorten it and propose again.`,
  full: `this person's memory holds ${MAX_ITEMS} items; ask them what to forget before proposing more.`,
};

registerDeliveryAction(
  'person_memory_propose',
  async (content, session) => {
    const outcome = await proposeItem(session, content.text);
    if (!outcome.ok) await notifyAgent(session, `zapamatovat refused: ${REFUSALS[outcome.reason]}`);
  },
  unguarded('holds a proposal only; the item is stored solely on the person\'s own yes, judged by host code'),
);

registerDeliveryAction(
  'person_memory_forget',
  async (content, session) => {
    const ids =
      content.all === true
        ? ('all' as const)
        : Array.isArray(content.ids)
          ? content.ids.filter((n): n is number => Number.isInteger(n))
          : [];
    if (ids !== 'all' && ids.length === 0) {
      await notifyAgent(session, 'zapomenout refused: give item numbers or all=true.');
      return;
    }
    const removed = await forgetOnRequest(session, ids);
    if (removed === null) await notifyAgent(session, 'zapomenout refused: person memory exists only in a 1:1 DM.');
    else if (removed.length === 0) await notifyAgent(session, 'zapomenout: no matching items; nothing was removed.');
  },
  unguarded("removes only from the requester's own memory in their DM session, and the host announces it to them"),
);
