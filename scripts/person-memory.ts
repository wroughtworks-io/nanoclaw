/**
 * Operator erasure for per-person memory (decision 0026). Dry-run by default.
 *
 *   pnpm exec tsx scripts/person-memory.ts forget <user_id>           # how many agents hold a memory for them
 *   pnpm exec tsx scripts/person-memory.ts forget <user_id> --apply   # delete it for every agent
 *
 * <user_id> is the NanoClaw user id, e.g. slack:U0123ABC. Prints counts only, never memory content.
 * Removes the memory folders and every proposal row for the person. Backups keep a deleted
 * memory until they age out (30 days); session transcripts are not touched (separate card).
 */
import fs from 'fs';

import { initDb } from '../src/db/index.js';
import { eraseRequester, peopleRoot, personDir } from '../src/person-memory.js';

const [cmd, userId] = process.argv.slice(2);
if (cmd !== 'forget' || !userId) {
  console.error('Usage: person-memory.ts forget <user_id> [--apply]');
  process.exit(2);
}
const root = peopleRoot();
const holders = fs.existsSync(root)
  ? fs.readdirSync(root).filter((ag) => fs.existsSync(personDir(ag, userId)))
  : [];
if (!process.argv.includes('--apply')) {
  console.log(`DRY-RUN: ${holders.length} agent(s) hold a memory for this person: ${holders.join(', ') || '—'}`);
  process.exit(0);
}
await initDb();
const r = await eraseRequester(userId);
console.log(`APPLY: removed ${r.folders} folder(s) and ${r.proposals} proposal row(s)`);
