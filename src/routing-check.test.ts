/**
 * Nightly routing check — replays the guard's rule over delivered replies and
 * flags any reroute-worthy reply the host log never rerouted (guard bypassed).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-routing-check',
    GROUPS_DIR: '/tmp/nanoclaw-test-routing-check/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-routing-check';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDb } from './db/connection.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession, withMailboxSession } from './session-manager.js';
import { createDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { upsertUserDm } from './modules/permissions/db/user-dms.js';
import { formatRoutingCheck, reroutedIdsFromLog, runRoutingCheck } from './routing-check.js';
import type { Session } from './types.js';

const now = (): string => new Date().toISOString();

async function dm(id: string, platformId: string, name: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: 'slack',
    platform_id: platformId,
    name,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

async function wire(mgId: string): Promise<void> {
  await createDestination({
    agent_group_id: 'ag-1',
    local_name: mgId,
    target_type: 'channel',
    target_id: mgId,
    created_at: now(),
  });
}

async function user(id: string, role?: 'owner' | 'admin', dmMgId?: string): Promise<void> {
  await upsertUser({ id, kind: 'slack', display_name: id, created_at: now() });
  if (role) await grantRole({ user_id: id, role, agent_group_id: null, granted_by: null, granted_at: now() });
  if (dmMgId)
    await upsertUserDm({ user_id: id, channel_type: 'slack', messaging_group_id: dmMgId, resolved_at: now() });
}

/**
 * The topology of the incident: an agent wired to a group channel and to
 * three DMs — an employee (Tereza), another employee, and the owner.
 */
async function seed(): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Klara', folder: 'klara', agent_provider: null, created_at: now() });
  await dm('mg-dm-tereza', 'slack:D-TEREZA', 'DM Tereza');
  await dm('mg-dm-other', 'slack:D-OTHER', 'DM Other');
  await dm('mg-dm-owner', 'slack:D-OWNER', 'DM Owner');
  await createMessagingGroup({
    id: 'mg-channel',
    channel_type: 'slack',
    platform_id: 'slack:C-PROJECT',
    name: 'd-bacherovky',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const mg of ['mg-dm-tereza', 'mg-dm-other', 'mg-dm-owner', 'mg-channel']) await wire(mg);
  await user('slack:U-TEREZA', undefined, 'mg-dm-tereza');
  await user('slack:U-OTHER', undefined, 'mg-dm-other');
  await user('slack:U-OWNER', 'owner', 'mg-dm-owner');
}

async function inbound(
  session: Session,
  id: string,
  from: { channelType: string; platformId: string; threadId?: string | null; senderId: string },
): Promise<void> {
  await withMailboxSession('ag-1', session.id, (mailbox) =>
    mailbox.insertMessage({
      id,
      kind: 'chat',
      timestamp: now(),
      platformId: from.platformId,
      channelType: from.channelType,
      threadId: from.threadId ?? null,
      content: JSON.stringify({ text: 'question', senderId: from.senderId }),
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    }),
  );
}

function outbound(session: Session, id: string, platformId: string, inReplyTo: string | null): void {
  const db = new Database(outboundDbPath('ag-1', session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content, in_reply_to)
     VALUES (?, datetime('now'), 'chat', ?, 'slack', ?, ?)`,
  ).run(id, platformId, JSON.stringify({ text: `reply ${id}` }), inReplyTo);
  db.close();
}

function markDelivered(session: Session, id: string, at = now()): void {
  const db = new Database(inboundDbPath('ag-1', session.id));
  db.prepare(
    "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, 'p', 'delivered', ?)",
  ).run(id, at);
  db.close();
}

const SINCE = new Date(Date.now() - 24 * 3600_000).toISOString();

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await seed();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function incident(): Promise<Session> {
  const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
  await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
  outbound(session, 'out-1', 'slack:C-PROJECT', 'in-1');
  markDelivered(session, 'out-1');
  return session;
}

describe('routing check', () => {
  it('parses rerouted ids from the host log line format', () => {
    const line =
      '[17:27:39.530] WARN Cross-conversation reply rerouted to origin id="out-1" sessionId="sess-9" intended="mg-c"';
    expect([...reroutedIdsFromLog(`noise\n${line}\n[x] INFO Message delivered id="out-2"`)]).toEqual(['out-1']);
  });

  it('a misaddressed reply the host rerouted is reported as rerouted', async () => {
    await incident();
    const r = await runRoutingCheck({ since: SINCE, rerouteLogIds: new Set(['out-1']) });
    expect(r.rerouted).toEqual([{ id: 'out-1', agent: 'Klara', from: 'DM Tereza', intended: 'd-bacherovky' }]);
    expect(r.bypassed).toEqual([]);
  });

  it('a misaddressed reply with no reroute in the log is flagged as a guard bypass', async () => {
    await incident();
    const r = await runRoutingCheck({ since: SINCE, rerouteLogIds: new Set() });
    expect(r.bypassed.map((b) => b.id)).toEqual(['out-1']);
    expect(formatRoutingCheck(r, 'staging', false)).toContain('guard bypassed');
  });

  it('counts allowed cross-posts, ignores own-conversation replies and old deliveries', async () => {
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-esc', 'slack:D-OWNER', 'in-1'); // escalation to the owner
    markDelivered(session, 'out-esc');
    outbound(session, 'out-home', 'slack:D-TEREZA', 'in-1');
    markDelivered(session, 'out-home');
    outbound(session, 'out-old', 'slack:C-PROJECT', 'in-1');
    markDelivered(session, 'out-old', '2026-01-01T00:00:00.000Z');

    const r = await runRoutingCheck({ since: SINCE, rerouteLogIds: new Set() });
    expect(r).toMatchObject({ delivered: 2, allowed: { 'owner-dm': 1 }, rerouted: [], bypassed: [] });
    expect(formatRoutingCheck(r, 'production', false)).toBeNull(); // silent when clean
    expect(formatRoutingCheck(r, 'production', true)).toContain('OK — 2 replies');
  });
});
