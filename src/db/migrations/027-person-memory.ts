import type { Migration } from './index.js';

/**
 * Per-person memory (Wroughtworks decision 0026).
 *
 *   container_configs.person_memory — per-agent opt-in (0/1). Host-side: it
 *     decides whether a DM session gets the person's memory mounted and
 *     whether the host accepts proposals. No backfill: every row stays 0.
 *
 *   person_memory_proposals — an item the agent proposed, held until the
 *     person's next message in the DM. Stored as a memory only on a plain yes
 *     (src/person-memory.ts). status: pending | approved | declined |
 *     expired | superseded.
 *
 * Adds a column and a table only, so pinning the previous build is safe.
 */
export const migration027: Migration = {
  version: 27,
  name: 'person-memory',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN person_memory INTEGER NOT NULL DEFAULT 0;`);
    await db.exec(`
      CREATE TABLE person_memory_proposals (
        id                   TEXT PRIMARY KEY,
        session_id           TEXT NOT NULL,
        agent_group_id       TEXT NOT NULL,
        requester_user_id    TEXT NOT NULL,
        text                 TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'pending',
        created_at           TEXT NOT NULL,
        resolved_at          TEXT,
        resolved_message_id  TEXT
      );
    `);
    await db.exec(
      `CREATE INDEX idx_person_memory_proposals_session ON person_memory_proposals(session_id, status);`,
    );
  },
};
