import type { Migration } from './index.js';

/**
 * sessions.engaged_at — when a session first received a WAKING (trigger=1)
 * message, i.e. when the agent was actually addressed in that conversation.
 *
 * mention-sticky engagement keys off this column, NOT off bare session
 * existence: an `ignored_message_policy: 'accumulate'` wiring creates a
 * per-thread session just to store unmentioned messages as context
 * (trigger=0). Treating that session as a subscription made the first
 * untagged top-level message "engage" the agent for every later untagged
 * reply in its thread.
 *
 * Backfill: every pre-existing session is stamped engaged (created_at), which
 * reproduces the pre-migration sticky behavior for live threads. We cannot
 * tell stored-context-only sessions apart from engaged ones in SQL (the
 * trigger flag lives in the per-session mailbox), so those old context-only
 * threads stay sticky until they go quiet; new ones are correct.
 */
export const migration025: Migration = {
  version: 25,
  name: 'session-engaged-at',
  async up(db) {
    await db.exec(`ALTER TABLE sessions ADD COLUMN engaged_at TEXT;`);
    await db.exec(`UPDATE sessions SET engaged_at = created_at WHERE engaged_at IS NULL;`);
  },
};
