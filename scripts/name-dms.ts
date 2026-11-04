/**
 * Backfill names for existing DMs ("DM <person>") and readable destination
 * addresses (dm-<person>). Dry-run by default: prints the plan and the exact
 * ncl commands. --apply runs them through ncl (host stays the single writer).
 *
 *   pnpm exec tsx scripts/name-dms.ts            # dry run
 *   pnpm exec tsx scripts/name-dms.ts --apply    # apply via ncl
 *
 * The person is resolved, in order, from: the DM session's host-set
 * requester_user_id → users.display_name; the user_dms cache; the newest
 * named sender in the DM's own inbound messages. DMs it cannot resolve are
 * listed and left untouched. Prints names and ids only, never message content.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import { planDmBackfill, planToCommands, type DmRow } from '../src/dm-backfill.js';
import { inboundDbPath } from '../src/mailbox/sqlite/paths.js';
import { senderFromRawContent } from '../src/sender-identity.js';

const apply = process.argv.includes('--apply');
await initDb(CENTRAL_DB_PATH, { role: 'tool' });
const db = getDb();

const dms = await db.all<{ id: string; name: string | null; channel_type: string }>(
  'SELECT id, name, channel_type FROM messaging_groups WHERE is_group = 0 AND channel_type != ?',
  'cli',
);
const destRows = await db.all<{ agent_group_id: string; local_name: string; target_id: string }>(
  "SELECT agent_group_id, local_name, target_id FROM agent_destinations WHERE target_type = 'channel'",
);
const allLocal = await db.all<{ agent_group_id: string; local_name: string }>(
  'SELECT agent_group_id, local_name FROM agent_destinations',
);
const taken = new Map<string, Set<string>>();
for (const r of allLocal) {
  if (!taken.has(r.agent_group_id)) taken.set(r.agent_group_id, new Set());
  taken.get(r.agent_group_id)!.add(r.local_name);
}

async function displayName(userId: string): Promise<string | null> {
  const u = await db.get<{ display_name: string | null }>('SELECT display_name FROM users WHERE id = ?', userId);
  return u?.display_name ?? null;
}

async function resolvePerson(mg: { id: string; channel_type: string }): Promise<{ name: string | null; via: string }> {
  const sessions = await db.all<{ id: string; agent_group_id: string; requester_user_id: string | null }>(
    'SELECT id, agent_group_id, requester_user_id FROM sessions WHERE messaging_group_id = ?',
    mg.id,
  );
  const requesters = [...new Set(sessions.map((s) => s.requester_user_id).filter((r): r is string => !!r))];
  if (requesters.length === 1) {
    const name = await displayName(requesters[0]!);
    if (name) return { name, via: 'session requester' };
  }
  const cached = await db.all<{ user_id: string }>('SELECT user_id FROM user_dms WHERE messaging_group_id = ?', mg.id);
  if (cached.length === 1) {
    const name = await displayName(cached[0]!.user_id);
    if (name) return { name, via: 'user_dms' };
  }
  for (const s of sessions) {
    const p = inboundDbPath(s.agent_group_id, s.id);
    if (!fs.existsSync(p)) continue;
    const inbound = new Database(p, { readonly: true, fileMustExist: true });
    try {
      const rows = inbound
        .prepare('SELECT content FROM messages_in WHERE channel_type = ? ORDER BY seq DESC LIMIT 50')
        .all(mg.channel_type) as Array<{ content: string }>;
      for (const r of rows) {
        const name = senderFromRawContent(r.content, mg.channel_type)?.displayName;
        if (name) return { name, via: 'inbound sender' };
      }
    } finally {
      inbound.close();
    }
  }
  return { name: null, via: 'unresolved' };
}

const rows: DmRow[] = [];
const via = new Map<string, string>();
for (const mg of dms) {
  const person = mg.name ? { name: null, via: 'already named' } : await resolvePerson(mg);
  via.set(mg.id, person.via);
  rows.push({
    id: mg.id,
    name: mg.name,
    personName: person.name,
    destinations: destRows
      .filter((d) => d.target_id === mg.id)
      .map((d) => ({ agentGroupId: d.agent_group_id, localName: d.local_name })),
  });
}

const plans = planDmBackfill(rows, taken);
const cmds = planToCommands(plans);
for (const p of plans) {
  const renames = p.renames.map((r) => `${r.from} → ${r.to}`).join(', ');
  console.log(
    p.skipped
      ? `SKIP  ${p.mgId}  (${p.skipped})`
      : `${p.setName ? `NAME  "${p.setName}"` : 'KEEP  name'}  ${p.mgId}  [${via.get(p.mgId)}]  ${renames}`,
  );
}
console.log(
  `\n${plans.filter((p) => !p.skipped).length} DM(s) to change, ${plans.filter((p) => p.skipped).length} skipped, ${cmds.length} ncl command(s).`,
);

if (!apply) {
  console.log('\nDRY-RUN. Commands --apply would run:');
  for (const c of cmds) console.log('  ncl ' + c.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' '));
  process.exit(0);
}

let failed = 0;
for (const c of cmds) {
  try {
    execFileSync('ncl', c, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('ok    ncl ' + c.slice(0, 3).join(' '));
  } catch (err) {
    failed++;
    console.log('FAIL  ncl ' + c.join(' ') + '  — ' + String((err as { stderr?: Buffer }).stderr ?? err).trim());
    // A failed "add" must not be followed by removing the old name.
    if (c[0] === 'destinations' && c[1] === 'add') {
      console.log('      stopping: the matching remove would leave the destination missing');
      process.exit(1);
    }
  }
}
console.log(`\nAPPLY: ${cmds.length - failed} ok, ${failed} failed.`);
process.exit(failed ? 1 : 0);
