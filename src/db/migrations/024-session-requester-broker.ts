import type { Migration } from './index.js';

/**
 * Notion token broker plumbing (fork contract v1).
 *
 *   sessions.requester_user_id   NanoClaw user id (e.g. `slack:U0123`) of the
 *                                person in a DM session. Host-set from the
 *                                routed sender of a messaging group with
 *                                is_group = 0; never writable by the agent.
 *   sessions.broker_token_hash   lowercase hex sha256 of the per-session
 *                                secret minted at container start. The broker
 *                                resolves a presented secret to a requester by
 *                                `WHERE broker_token_hash = ?`.
 *   container_configs.notion_broker
 *                                per-agent opt-in (0/1) to the personal Notion
 *                                server; container config is DB-materialized,
 *                                so the flag needs a column.
 *
 * No backfill: existing sessions stay NULL (no requester, no broker) and
 * existing configs stay 0 (opted out), reproducing pre-migration behavior.
 * An existing DM session gains its requester on its next inbound message.
 */
export const migration024: Migration = {
  version: 24,
  name: 'session-requester-broker',
  async up(db) {
    await db.exec(`ALTER TABLE sessions ADD COLUMN requester_user_id TEXT;`);
    await db.exec(`ALTER TABLE sessions ADD COLUMN broker_token_hash TEXT;`);
    await db.exec(`ALTER TABLE container_configs ADD COLUMN notion_broker INTEGER NOT NULL DEFAULT 0;`);
  },
};
