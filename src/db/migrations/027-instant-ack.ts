import type { Migration } from './index.js';

/**
 * Instant acknowledgement reaction (src/modules/ack).
 *
 * - container_configs.instant_ack: per-agent opt-in (0/1). When on, a message
 *   that wakes the agent gets a runtime eyes reaction if no reply has landed
 *   after a short delay.
 * - container_configs.ack_delay_ms: nullable per-agent override of that delay
 *   (NULL = module default).
 * - pending_acks: reactions the host has put on a user message and still owes a
 *   removal for. Host memory is the source of truth while running; this table
 *   exists only so a host restart can find and clear a stuck reaction.
 *
 * Host-side only: nothing reaches container.json, so no agent-image rebuild and
 * no container restart. No backfill: every existing row stays 0 (opted out).
 */
export const migration027: Migration = {
  version: 27,
  name: 'instant-ack',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN instant_ack INTEGER NOT NULL DEFAULT 0;`);
    await db.exec(`ALTER TABLE container_configs ADD COLUMN ack_delay_ms INTEGER;`);
    await db.exec(`
      CREATE TABLE pending_acks (
        session_id   TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        platform_id  TEXT NOT NULL,
        thread_id    TEXT,
        instance     TEXT,
        state        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
    `);
  },
};
