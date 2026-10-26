/**
 * One-off migration to per-session isolation (notion-access PLAN, Part B).
 *
 * Before: every session of an agent group shared `.claude-shared/projects`
 * (all SDK transcripts) and the group's `conversations/*.md` archives.
 * After: each session has its own Claude state (see session-claude-state.ts).
 *
 * This moves each existing transcript to the session that OWNS its SDK id —
 * ownership comes only from the id stored in that session's outbound.db
 * (`continuation:<provider>` / legacy `sdk_session_id`), never guessed. Anything
 * unattributable (no owner, several owners, rotated-away ids, per-project
 * sessions-index.json which mixes every session's summaries) and every existing
 * conversation archive goes to a host-only quarantine nothing mounts. Nothing is
 * deleted; a host-only tar backup is written first.
 *
 * Run with the service STOPPED: a live container writes the same files.
 * Idempotent: a second run finds nothing left to move and writes nothing.
 * Logs counts only — never filenames' content or transcript content.
 */
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { CLAUDE_STATE_DIRNAME } from './session-claude-state.js';

export interface MigrationRoots {
  /** DATA_DIR (contains v2-sessions/). */
  dataDir: string;
  /** GROUPS_DIR (contains <folder>/conversations). */
  groupsDir: string;
}

export interface Move {
  from: string;
  to: string;
}

export interface MigrationPlan {
  /** Transcripts moved into their owning session's state. */
  attributed: Move[];
  /** Unattributable transcript-area files (quarantine). */
  quarantinedTranscripts: Move[];
  /** Existing groups/*\/conversations/*.md (quarantine). */
  quarantinedArchives: Move[];
  /** Directories to tar before anything moves (source dir, tar name). */
  backups: Array<{ cwd: string; entry: string; name: string }>;
}

export interface MigrationCounts {
  attributed: number;
  quarantinedTranscripts: number;
  quarantinedArchives: number;
  backups: number;
}

const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.rotated-\d+)?$/i;

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** continuation ids stored by one session (empty if it has no readable outbound.db). */
function storedIds(outboundDb: string): string[] {
  if (!fs.existsSync(outboundDb)) return [];
  let db: Database.Database | undefined;
  try {
    db = new Database(outboundDb, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const rows = db
      .prepare("SELECT value FROM session_state WHERE key LIKE 'continuation:%' OR key = 'sdk_session_id'")
      .all() as Array<{ value: string }>;
    return rows.map((r) => r.value).filter((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return []; // no session_state table yet, or unreadable: owns nothing
  } finally {
    db?.close();
  }
}

export function planMigration(roots: MigrationRoots, stamp: string): MigrationPlan {
  const plan: MigrationPlan = { attributed: [], quarantinedTranscripts: [], quarantinedArchives: [], backups: [] };
  const sessionsRoot = path.join(roots.dataDir, 'v2-sessions');
  const quarantine = path.join(roots.dataDir, `isolation-quarantine-${stamp}`);

  for (const ag of subdirs(sessionsRoot)) {
    const projectsDir = path.join(sessionsRoot, ag, '.claude-shared', 'projects');
    const projects = subdirs(projectsDir);
    if (projects.length === 0) continue;

    // id -> owning sessions, within this agent group only.
    const owners = new Map<string, string[]>();
    for (const sess of subdirs(path.join(sessionsRoot, ag)).filter((n) => !n.startsWith('.'))) {
      for (const id of storedIds(path.join(sessionsRoot, ag, sess, 'outbound.db'))) {
        owners.set(id, [...(owners.get(id) ?? []), sess]);
      }
    }

    let any = false;
    for (const proj of projects) {
      const dir = path.join(projectsDir, proj);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        any = true;
        const from = path.join(dir, e.name);
        const m = e.isFile() ? TRANSCRIPT_RE.exec(e.name) : null;
        const sessions = m ? [...new Set(owners.get(m[1]) ?? [])] : [];
        if (m && sessions.length === 1) {
          const to = path.join(
            roots.dataDir,
            'v2-sessions',
            ag,
            CLAUDE_STATE_DIRNAME,
            sessions[0],
            'projects',
            proj,
            e.name,
          );
          // Never overwrite: a collision means something already lives there.
          if (!fs.existsSync(to)) {
            plan.attributed.push({ from, to });
            continue;
          }
        }
        plan.quarantinedTranscripts.push({ from, to: path.join(quarantine, ag, 'projects', proj, e.name) });
      }
    }
    if (any) {
      plan.backups.push({
        cwd: path.join(sessionsRoot, ag, '.claude-shared'),
        entry: 'projects',
        name: `${ag}-claude-shared-projects.tgz`,
      });
    }
  }

  for (const folder of subdirs(roots.groupsDir)) {
    const convDir = path.join(roots.groupsDir, folder, 'conversations');
    let files: string[];
    try {
      files = fs
        .readdirSync(convDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name);
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    for (const f of files) {
      plan.quarantinedArchives.push({
        from: path.join(convDir, f),
        to: path.join(quarantine, 'groups', folder, 'conversations', f),
      });
    }
    plan.backups.push({
      cwd: path.join(roots.groupsDir, folder),
      entry: 'conversations',
      name: `group-${folder}-conversations.tgz`,
    });
  }
  return plan;
}

export function countsOf(plan: MigrationPlan): MigrationCounts {
  return {
    attributed: plan.attributed.length,
    quarantinedTranscripts: plan.quarantinedTranscripts.length,
    quarantinedArchives: plan.quarantinedArchives.length,
    backups: plan.backups.length,
  };
}

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function moveFile(from: string, to: string): void {
  privateDirIfQuarantine(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

function privateDirIfQuarantine(to: string): void {
  const m = /^(.*\/isolation-quarantine-[^/]+)\//.exec(to);
  if (m) privateDir(m[1]);
}

/**
 * Apply a plan: backups first (any failure aborts before a single move), then
 * moves. Returns the counts actually performed. An empty plan writes nothing.
 */
export function applyMigration(roots: MigrationRoots, plan: MigrationPlan, stamp: string): MigrationCounts {
  const counts = countsOf(plan);
  if (counts.attributed + counts.quarantinedTranscripts + counts.quarantinedArchives === 0) {
    return { attributed: 0, quarantinedTranscripts: 0, quarantinedArchives: 0, backups: 0 };
  }
  const backupDir = path.join(roots.dataDir, `isolation-backup-${stamp}`);
  privateDir(backupDir);
  for (const b of plan.backups) {
    const out = path.join(backupDir, b.name);
    execFileSync('tar', ['-czf', out, '-C', b.cwd, b.entry]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error(`backup ${b.name} is empty; aborting`);
    fs.chmodSync(out, 0o600);
  }
  for (const mv of plan.attributed) moveFile(mv.from, mv.to);
  for (const mv of [...plan.quarantinedTranscripts, ...plan.quarantinedArchives]) moveFile(mv.from, mv.to);
  return counts;
}
