import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./claude-md-compose.js', () => ({ composeGroupClaudeMd: vi.fn() }));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DATA_DIR, GROUPS_DIR } from './config.js';
import type { ContainerConfig } from './container-config.js';
import { buildMounts, composeSessionSpec } from './container-runner.js';
import { seedMemoryScaffold } from './group-init.js';
import { applyMigration, countsOf, planMigration } from './isolation-migration.js';
import { sessionClaudeStateDir } from './session-claude-state.js';
import type { AgentGroup, Session } from './types.js';

const GROUP_ID = 'ag-isolation';
const FOLDER = 'isolation-test';
const groupDir = path.resolve(GROUPS_DIR, FOLDER);
const shared = path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.claude-shared');
const agentGroup = { id: GROUP_ID, name: 'Iso', folder: FOLDER } as AgentGroup;
const containerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;
const sess = (id: string) => ({ id, agent_group_id: GROUP_ID, agent_provider: null }) as Session;

beforeAll(() => {
  fs.mkdirSync(path.join(shared, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'settings.json'), '{}');
  fs.mkdirSync(groupDir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID), { recursive: true, force: true });
});

describe('per-session mounts', () => {
  it('gives each session its own .claude, outside /workspace, with RO overlays', async () => {
    const a = await buildMounts(agentGroup, sess('sA'), containerConfig, 'claude', {});
    const b = await buildMounts(agentGroup, sess('sB'), containerConfig, 'claude', {});
    const claude = (ms: typeof a) => ms.find((m) => m.containerPath === '/home/node/.claude')!;
    expect(claude(a).hostPath).toBe(sessionClaudeStateDir(GROUP_ID, 'sA'));
    expect(claude(a).hostPath).not.toBe(claude(b).hostPath);
    expect(claude(a).readonly).toBe(false);
    expect(claude(a).hostPath).not.toBe(shared);
    const ws = a.find((m) => m.containerPath === '/workspace')!;
    expect(claude(a).hostPath.startsWith(ws.hostPath + path.sep)).toBe(false);
    const settings = a.find((m) => m.containerPath === '/home/node/.claude/settings.json')!;
    const skills = a.find((m) => m.containerPath === '/home/node/.claude/skills')!;
    expect(settings).toMatchObject({ hostPath: path.join(shared, 'settings.json'), readonly: true });
    expect(skills).toMatchObject({ hostPath: path.join(shared, 'skills'), readonly: true });
    expect(a.map((m) => m.hostPath)).not.toContain(shared);
  });

  it('mounts memory/ read-only over the RW group dir', async () => {
    const ms = await buildMounts(agentGroup, sess('sA'), containerConfig, 'claude', {});
    expect(ms.find((m) => m.containerPath === '/workspace/agent/memory')).toMatchObject({
      hostPath: path.join(groupDir, 'memory'),
      readonly: true,
    });
  });

  it('points archives at the session state, and not when no state is mounted', async () => {
    const ms = await buildMounts(agentGroup, sess('sA'), containerConfig, 'claude', {});
    const base = {
      agentGroup,
      session: sess('sA'),
      containerName: 'n',
      containerConfig,
      mailboxEnvironment: { NANOCLAW_CONVERSATIONS_DIR: '/workspace/agent/conversations' },
      contribution: {} as never,
      gateway: {} as never,
    };
    expect(composeSessionSpec({ ...base, mounts: ms }).containers[0].env.NANOCLAW_CONVERSATIONS_DIR).toBe(
      '/home/node/.claude/conversations',
    );
    const none = composeSessionSpec({ ...base, mounts: ms.filter((m) => m.containerPath !== '/home/node/.claude') });
    expect(none.containers[0].env.NANOCLAW_CONVERSATIONS_DIR).toBe('/workspace/agent/conversations');
  });
});

describe('host-side memory seed', () => {
  it('seeds missing files only and never clobbers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-mem-'));
    try {
      expect(seedMemoryScaffold(dir)).toBe(true);
      const idx = path.join(dir, 'memory', 'index.md');
      expect(fs.existsSync(idx)).toBe(true);
      fs.writeFileSync(idx, 'mine');
      expect(seedMemoryScaffold(dir)).toBe(false);
      expect(fs.readFileSync(idx, 'utf-8')).toBe('mine');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migration', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const UUID_X = '33333333-3333-4333-8333-333333333333';
  let root: string;
  let roots: { dataDir: string; groupsDir: string };

  function mkSession(sessId: string, id: string) {
    const d = path.join(roots.dataDir, 'v2-sessions', 'ag1', sessId);
    fs.mkdirSync(d, { recursive: true });
    const db = new Database(path.join(d, 'outbound.db'));
    db.exec('CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO session_state VALUES (?,?,?)').run('continuation:claude', id, 'x');
    db.close();
  }
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        out.push(p);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out.sort();
  }

  function setup() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-mig-'));
    roots = { dataDir: path.join(root, 'data'), groupsDir: path.join(root, 'groups') };
    mkSession('sA', UUID_A);
    mkSession('sB', UUID_B);
    const proj = path.join(roots.dataDir, 'v2-sessions', 'ag1', '.claude-shared', 'projects', '-workspace-agent');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${UUID_A}.jsonl`), 'a');
    fs.writeFileSync(path.join(proj, `${UUID_B}.jsonl`), 'b');
    fs.writeFileSync(path.join(proj, `${UUID_X}.jsonl`), 'x');
    fs.writeFileSync(path.join(proj, `${UUID_A}.jsonl.rotated-123`), 'ar');
    fs.writeFileSync(path.join(proj, 'sessions-index.json'), '{}');
    const conv = path.join(roots.groupsDir, 'f1', 'conversations');
    fs.mkdirSync(conv, { recursive: true });
    fs.writeFileSync(path.join(conv, '2026-01-01-x.md'), 'md');
  }

  it('dry-run plans but changes nothing', () => {
    setup();
    try {
      const before = snapshot(root);
      const plan = planMigration(roots, 'T1');
      expect(countsOf(plan)).toMatchObject({ attributed: 3, quarantinedTranscripts: 2, quarantinedArchives: 1 });
      expect(snapshot(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('apply attributes by stored id, quarantines the rest, backs up first, and is idempotent', () => {
    setup();
    try {
      const plan = planMigration(roots, 'T1');
      const c = applyMigration(roots, plan, 'T1');
      expect(c).toMatchObject({ attributed: 3, quarantinedTranscripts: 2, quarantinedArchives: 1, backups: 2 });
      const st = (s: string, f: string) =>
        path.join(roots.dataDir, 'v2-sessions', 'ag1', '.claude-state', s, 'projects', '-workspace-agent', f);
      expect(fs.readFileSync(st('sA', `${UUID_A}.jsonl`), 'utf-8')).toBe('a');
      expect(fs.existsSync(st('sA', `${UUID_A}.jsonl.rotated-123`))).toBe(true);
      expect(fs.readFileSync(st('sB', `${UUID_B}.jsonl`), 'utf-8')).toBe('b');
      expect(fs.existsSync(st('sB', `${UUID_A}.jsonl`))).toBe(false);
      const q = path.join(roots.dataDir, 'isolation-quarantine-T1');
      expect(fs.existsSync(path.join(q, 'ag1', 'projects', '-workspace-agent', `${UUID_X}.jsonl`))).toBe(true);
      expect(fs.existsSync(path.join(q, 'ag1', 'projects', '-workspace-agent', 'sessions-index.json'))).toBe(true);
      expect(fs.existsSync(path.join(q, 'groups', 'f1', 'conversations', '2026-01-01-x.md'))).toBe(true);
      expect(fs.statSync(q).mode & 0o777).toBe(0o700);
      const bdir = path.join(roots.dataDir, 'isolation-backup-T1');
      expect(fs.statSync(bdir).mode & 0o777).toBe(0o700);
      const tgz = path.join(bdir, 'ag1-claude-shared-projects.tgz');
      expect(execFileSync('tar', ['-tzf', tgz]).toString()).toContain(`${UUID_X}.jsonl`);
      // nothing left in the shared area
      const left = planMigration(roots, 'T2');
      expect(countsOf(left)).toMatchObject({ attributed: 0, quarantinedTranscripts: 0, quarantinedArchives: 0 });
      const before = snapshot(root);
      expect(applyMigration(roots, left, 'T2')).toMatchObject({ attributed: 0, backups: 0 });
      expect(snapshot(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines a transcript claimed by two sessions', () => {
    setup();
    try {
      mkSession('sC', UUID_A);
      const plan = planMigration(roots, 'T1');
      expect(plan.attributed.map((m) => path.basename(m.from))).toEqual([`${UUID_B}.jsonl`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
