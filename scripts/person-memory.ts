/**
 * Operator erasure for per-person memory (decision 0026). Dry-run by default.
 *
 *   pnpm exec tsx scripts/person-memory.ts forget <user_id>           # how many agents hold a memory for them
 *   pnpm exec tsx scripts/person-memory.ts forget <user_id> --apply   # delete it for every agent
 *
 * <user_id> is the NanoClaw user id, e.g. slack:U0123ABC. Prints counts only, never memory content.
 * Backups keep a deleted memory until they age out (30 days).
 */
import fs from 'fs';

import { erasePerson, peopleRoot, personDir } from '../src/person-memory.js';

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
console.log(`APPLY: removed ${erasePerson(userId)} folder(s)`);
