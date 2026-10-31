import type { Migration } from './index.js';

/**
 * container_configs.slack_context_fetch — per-agent opt-in (0/1) to fetching
 * Slack thread / channel history when the agent is engaged by a mention
 * (see src/conversation-context.ts).
 *
 * Host-side only: the flag is read by the router and never reaches
 * container.json, so enabling it needs no agent-image rebuild and no
 * container restart.
 *
 * No backfill: every existing row stays 0 (opted out), reproducing
 * pre-migration behavior.
 */
export const migration026: Migration = {
  version: 26,
  name: 'slack-context-fetch',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN slack_context_fetch INTEGER NOT NULL DEFAULT 0;`);
  },
};
