/**
 * Reply-routing guard — a reply stays in the conversation it answers.
 *
 * Replays the 2026-11-04 production incident (a DM reply addressed to a
 * group channel after context compaction) and the three legitimate
 * cross-conversation shapes seen in the same production scan (operator CLI
 * → DM, owner's DM → someone else's DM, employee DM → owner's DM).
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
    DATA_DIR: '/tmp/nanoclaw-test-reply-routing',
    GROUPS_DIR: '/tmp/nanoclaw-test-reply-routing/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-reply-routing';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDb } from './db/connection.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession, resolveTaskSession, withMailboxSession } from './session-manager.js';
import { deliverSessionMessages, registerPostDeliveryHook, setDeliveryAdapter } from './delivery.js';
import { createDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { upsertUserDm } from './modules/permissions/db/user-dms.js';
import { log } from './log.js';
import type { Session } from './types.js';

const now = (): string => new Date().toISOString();

interface Sent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  text: string;
}

let sent: Sent[];

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

/** Lets the fire-and-forget owner alert settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  sent = [];
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, _kind, content) {
      sent.push({ channelType, platformId, threadId, text: JSON.parse(content).text });
      return `plat-${sent.length}`;
    },
  });
  await seed();
});

afterEach(async () => {
  await settle(); // fire-and-forget owner alerts must not outlive the DB
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('reply-routing guard', () => {
  it('replays the incident: an employee DM reply addressed to a channel is delivered to the DM, owner alerted', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-1', 'slack:C-PROJECT', 'in-1');

    await deliverSessionMessages(session);
    await settle();

    expect(sent.filter((s) => s.platformId === 'slack:C-PROJECT')).toHaveLength(0);
    expect(sent[0]).toMatchObject({ platformId: 'slack:D-TEREZA', text: 'reply out-1' });
    expect(warn).toHaveBeenCalledWith(
      'Cross-conversation reply rerouted to origin',
      expect.objectContaining({ id: 'out-1', intended: 'mg-channel', deliveredTo: 'mg-dm-tereza' }),
    );
    const alert = sent.find((s) => s.platformId === 'slack:D-OWNER');
    expect(alert?.text).toContain('d-bacherovky');
    expect(alert?.text).not.toContain('reply out-1'); // conversations named, content never copied
  });

  it('keeps the reply in the thread it answers', async () => {
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', {
      channelType: 'slack',
      platformId: 'slack:D-TEREZA',
      threadId: 'ts-123',
      senderId: 'slack:U-TEREZA',
    });
    outbound(session, 'out-1', 'slack:C-PROJECT', 'in-1');

    await deliverSessionMessages(session);

    expect(sent[0]).toMatchObject({ platformId: 'slack:D-TEREZA', threadId: 'ts-123' });
  });

  it('fails closed when the reply carries no in_reply_to: delivered to the session origin', async () => {
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    outbound(session, 'out-1', 'slack:C-PROJECT', null);

    await deliverSessionMessages(session);

    expect(sent[0]).toMatchObject({ platformId: 'slack:D-TEREZA' });
  });

  it('observers (fan-out, post-delivery hooks) see the address the reply was delivered to', async () => {
    const seen: Array<string | null> = [];
    registerPostDeliveryHook((msg) => {
      seen.push(msg.platformId);
    });
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-1', 'slack:C-PROJECT', 'in-1');

    await deliverSessionMessages(session);

    expect(seen).toEqual(['slack:D-TEREZA']);
  });

  it('allows: operator CLI → someone’s DM (Věra notes delivery)', async () => {
    const { session } = await resolveSession('ag-1', 'mg-dm-owner', null, 'shared');
    await inbound(session, 'in-cli', { channelType: 'cli', platformId: 'cli:local', senderId: 'cli:local' });
    outbound(session, 'out-1', 'slack:D-OTHER', 'in-cli');

    await deliverSessionMessages(session);

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:D-OTHER' })]);
  });

  it('allows: owner asks in their DM, the agent delivers to another person’s DM', async () => {
    const { session } = await resolveSession('ag-1', 'mg-dm-owner', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-OWNER', senderId: 'slack:U-OWNER' });
    outbound(session, 'out-1', 'slack:D-OTHER', 'in-1');

    await deliverSessionMessages(session);

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:D-OTHER' })]);
  });

  it('allows: an employee DM escalated to the owner’s DM', async () => {
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-1', 'slack:D-OWNER', 'in-1');

    await deliverSessionMessages(session);

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:D-OWNER' })]);
  });

  it('allows: escalation to the owner’s DM with another bot — not in the user_dms cache, known from its session', async () => {
    // Each agent is its own Slack app, so the owner has one DM per bot; the
    // user_dms cache holds only one of them (here mg-dm-owner).
    await dm('mg-dm-owner-bot2', 'slack:D-OWNER-2', 'DM Owner (bot 2)');
    await wire('mg-dm-owner-bot2');
    const { session: ownerDmSession } = await resolveSession('ag-1', 'mg-dm-owner-bot2', null, 'shared');
    await getDb().run('UPDATE sessions SET requester_user_id = ? WHERE id = ?', 'slack:U-OWNER', ownerDmSession.id);

    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-1', 'slack:D-OWNER-2', 'in-1');

    await deliverSessionMessages(session);

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:D-OWNER-2' })]);
  });

  it('a DM session of a non-owner does not make that DM an owner DM', async () => {
    const { session: otherSession } = await resolveSession('ag-1', 'mg-dm-other', null, 'shared');
    await getDb().run('UPDATE sessions SET requester_user_id = ? WHERE id = ?', 'slack:U-OTHER', otherSession.id);

    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-1', 'slack:D-OTHER', 'in-1');

    await deliverSessionMessages(session);

    expect(sent[0]).toMatchObject({ platformId: 'slack:D-TEREZA' });
  });

  it('allows: a scoped admin of the agent group may direct a cross-post', async () => {
    await upsertUser({ id: 'slack:U-ADMIN', kind: 'slack', display_name: 'admin', created_at: now() });
    await grantRole({
      user_id: 'slack:U-ADMIN',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    const { session } = await resolveSession('ag-1', 'mg-dm-other', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-OTHER', senderId: 'slack:U-ADMIN' });
    outbound(session, 'out-1', 'slack:C-PROJECT', 'in-1');

    await deliverSessionMessages(session);

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:C-PROJECT' })]);
  });

  it('unchanged: a reply to its own conversation', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session } = await resolveSession('ag-1', 'mg-dm-tereza', null, 'shared');
    await inbound(session, 'in-1', { channelType: 'slack', platformId: 'slack:D-TEREZA', senderId: 'slack:U-TEREZA' });
    outbound(session, 'out-1', 'slack:D-TEREZA', 'in-1');

    await deliverSessionMessages(session);
    await settle();

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:D-TEREZA' })]);
    expect(warn).not.toHaveBeenCalledWith('Cross-conversation reply rerouted to origin', expect.anything());
  });

  it('unchanged: a task session posting to a wired channel', async () => {
    const { session } = await resolveTaskSession('ag-1', 'weekly-digest-a1b2');
    outbound(session, 'out-1', 'slack:C-PROJECT', null);

    await deliverSessionMessages(session);

    expect(sent).toEqual([expect.objectContaining({ platformId: 'slack:C-PROJECT' })]);
  });
});
