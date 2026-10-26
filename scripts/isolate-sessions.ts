/**
 * Per-session isolation migration. Dry-run by default.
 *
 *   pnpm exec tsx scripts/isolate-sessions.ts            # print the plan (counts only), change nothing
 *   pnpm exec tsx scripts/isolate-sessions.ts --apply    # back up, move, quarantine
 *
 * Stop the NanoClaw service first when applying. See src/isolation-migration.ts.
 */
import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { applyMigration, countsOf, planMigration } from '../src/isolation-migration.js';

const apply = process.argv.includes('--apply');
if (apply && process.argv.includes('--dry-run')) {
  console.error('Choose one of --apply or --dry-run.');
  process.exit(2);
}
const roots = { dataDir: DATA_DIR, groupsDir: GROUPS_DIR };
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const plan = planMigration(roots, stamp);
const c = countsOf(plan);
console.log(
  `${apply ? 'APPLY' : 'DRY-RUN'}: transcripts to attribute ${c.attributed}, ` +
    `transcript files to quarantine ${c.quarantinedTranscripts}, ` +
    `conversation archives to quarantine ${c.quarantinedArchives}, backups ${c.backups}`,
);
if (apply) {
  const done = applyMigration(roots, plan, stamp);
  console.log(
    `DONE: attributed ${done.attributed}, quarantined ${done.quarantinedTranscripts + done.quarantinedArchives}, backups ${done.backups}`,
  );
} else {
  console.log('Nothing changed. Re-run with --apply (service stopped) to perform it.');
}
