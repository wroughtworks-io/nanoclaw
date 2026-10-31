/**
 * Per-person memory (decision 0026). The rule under test: nothing is stored
 * unless the session's own requester answers a pending proposal with a plain
 * yes — judged here, in host code, through the real routeInbound path.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound, setSenderResolver } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import {
  eraseRequester,
  forgetOnRequest,
  onDelivered,
  isPlainYes,
  listItems,
  personDir,
  PROPOSAL_TTL_MS,
  proposeItem,
} from './person-memory.js';
import type { Session } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-person-memory' };
});

const TEST_DIR = '/tmp/nanoclaw-test-person-memory';
const now = () => new Date().toISOString();
const A = 'testchat:U1';
const B = 'testchat:U2';

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function seed(isGroup: 0 | 1, flag: 0 | 1 = 1): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  await getDb().run(
    'INSERT INTO container_configs (agent_group_id, updated_at, person_memory) VALUES (?, ?, ?)',
    'ag-1',
    now(),
    flag,
  );
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Chat',
    is_group: isGroup,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

let sender: string | null = A;
async function say(id: string, text: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'X', senderId: 'U', text }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  });
}

async function theSession(): Promise<Session> {
  const s = await getDb().get<Session>('SELECT * FROM sessions');
  if (!s) throw new Error('no session');
  return s;
}

function agentSaw(session: Session): string[] {
  const db = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
  const rows = db.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
  db.close();
  return rows.map((r) => (JSON.parse(r.content) as { text?: string }).text ?? '');
}

function hostSaid(session: Session): string[] {
  const db = new Database(outboundDbPath('ag-1', session.id), { readonly: true });
  const rows = db.prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
  db.close();
  return rows.map((r) => (JSON.parse(r.content) as { text?: string }).text ?? '');
}

/** The delivery loop reaching the person with the latest ask (the post-delivery hook). */
async function deliverAsk(s: Session): Promise<void> {
  const row = await getDb().get<{ ask_message_id: string }>(
    `SELECT ask_message_id FROM person_memory_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`,
  );
  await onDelivered(row!.ask_message_id, s);
}

async function propose(s: Session, text: string): Promise<void> {
  expect(await proposeItem(s, text)).toMatchObject({ ok: true });
  await deliverAsk(s);
}

async function proposals(): Promise<string[]> {
  const rows = await getDb().all<{ status: string }>('SELECT status FROM person_memory_proposals ORDER BY created_at');
  return rows.map((r) => r.status);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  sender = A;
  setSenderResolver(async () => sender);
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('isPlainYes', () => {
  it.each(['ano', 'Ano.', ' jo ', 'JJ', 'ok!', 'okay', 'yes', '👍'])('accepts %j', (t) => {
    expect(isPlainYes(t)).toBe(true);
  });
  it.each(['ano, ale jen v pondělí', 'ne', 'anoo', 'asi jo', 'ok díky', '', 'zapamatuj si to'])('refuses %j', (t) => {
    expect(isPlainYes(t)).toBe(false);
  });
});

describe('per-person memory in a DM', () => {
  it('stores only on the requester\'s plain yes, consumes the yes, and posts the exact text first', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Preferuje stručné odpovědi.');
    expect(hostSaid(s).join('\n')).toContain('„Preferuje stručné odpovědi.“');
    expect(listItems('ag-1', A)).toEqual([]);

    await say('m2', 'ano');
    const items = listItems('ag-1', A);
    expect(items.map((i) => i.text)).toEqual(['Preferuje stručné odpovědi.']);
    expect(items[0]).toMatchObject({ session_id: s.id, approval_message_id: 'm2' });
    expect(await proposals()).toEqual(['approved']);
    expect(agentSaw(s)).not.toContain('ano');
    expect(fs.readFileSync(path.join(personDir('ag-1', A), 'PAMET.md'), 'utf8')).toContain('1. Preferuje stručné odpovědi.');
  });

  it('a near-yes declines, stores nothing, and reaches the agent', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Pracuje na projektu Bachrova.');
    await say('m2', 'ano, ale jen do konce roku');
    expect(listItems('ag-1', A)).toEqual([]);
    expect(await proposals()).toEqual(['declined']);
    expect(agentSaw(s)).toContain('ano, ale jen do konce roku');
  });

  it('a yes from anyone but the requester stores nothing', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Něco o A.');
    sender = B;
    await say('m2', 'ano');
    expect(listItems('ag-1', A)).toEqual([]);
    expect(await proposals()).toEqual(['pending']);
  });

  it('an expired proposal stores nothing', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Staré.');
    const old = new Date(Date.now() - PROPOSAL_TTL_MS - 1000).toISOString();
    await getDb().run('UPDATE person_memory_proposals SET created_at = ?', old);
    await say('m2', 'ano');
    expect(listItems('ag-1', A)).toEqual([]);
    expect(await proposals()).toEqual(['expired']);
    expect(agentSaw(s)).toContain('ano');
  });

  it('a new proposal supersedes the pending one; only the latest can be approved', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'První.');
    await propose(s, 'Druhé.');
    await say('m2', 'jo');
    expect(listItems('ag-1', A).map((i) => i.text)).toEqual(['Druhé.']);
    expect((await proposals()).sort()).toEqual(['approved', 'superseded']);
  });

  it('refuses empty and over-long text', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    expect(await proposeItem(s, '  ')).toEqual({ ok: false, reason: 'empty' });
    expect(await proposeItem(s, 'x'.repeat(501))).toEqual({ ok: false, reason: 'too_long' });
    expect(await proposals()).toEqual([]);
  });

  it('forgets on request and announces it; erasure removes the folder', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Jedna.');
    await say('m2', 'ano');
    await propose(s, 'Dvě.');
    await say('m3', 'ano');
    const removed = await forgetOnRequest(s, [1]);
    expect(removed?.map((i) => i.text)).toEqual(['Jedna.']);
    expect(listItems('ag-1', A).map((i) => i.text)).toEqual(['Dvě.']);
    expect(hostSaid(s).join('\n')).toContain('Zapomenuto:\n„Jedna.“');
    expect(await eraseRequester(A)).toEqual({ folders: 1, proposals: 2 });
    expect(fs.existsSync(personDir('ag-1', A))).toBe(false);
  });

  it('a yes before the ask was delivered stores nothing and leaves it pending', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await proposeItem(s, 'Nedoručené.');
    await say('m2', 'ano');
    expect(listItems('ag-1', A)).toEqual([]);
    expect(await proposals()).toEqual(['pending']);
    expect(agentSaw(s)).toContain('ano');
  });

  it('any message delivered after the ask voids it, so a later yes stores nothing', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Přerušené.');
    await onDelivered('agent-question-after-the-ask', s);
    await say('m2', 'ano');
    expect(listItems('ag-1', A)).toEqual([]);
    expect(await proposals()).toEqual(['interrupted']);
  });

  it('two quick yeses store the item once', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Jednou.');
    await Promise.all([say('m2', 'ano'), say('m3', 'jo')]);
    expect(listItems('ag-1', A).map((i) => i.text)).toEqual(['Jednou.']);
  });

  it('settled proposals keep no text', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    const s = await theSession();
    await propose(s, 'Odmítnuté.');
    await say('m2', 'ne');
    await propose(s, 'Přijaté.');
    await say('m3', 'ano');
    const texts = await getDb().all<{ text: string }>('SELECT text FROM person_memory_proposals');
    expect(texts.map((t) => t.text)).toEqual(['', '']);
  });

  it('an agent with an agent-shared wiring gets no personal memory', async () => {
    await seed(0);
    await say('m1', 'ahoj');
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'testchat',
      platform_id: 'testchat:C2',
      instance: 'testchat',
      name: 'Kanál',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    const s = await theSession();
    expect(await proposeItem(s, 'Cokoli.')).toEqual({ ok: false, reason: 'disabled' });
    expect(await forgetOnRequest(s, 'all')).toBeNull();
  });
});

describe('per-person memory outside a DM, or switched off', () => {
  it('a channel session has no requester, so a proposal is refused', async () => {
    await seed(1);
    await say('m1', 'ahoj');
    const s = await theSession();
    expect(s.requester_user_id ?? null).toBeNull();
    expect(await proposeItem(s, 'Cokoli.')).toEqual({ ok: false, reason: 'not_a_dm' });
  });

  it('a session whose requester was set but whose group is not a DM is still refused', async () => {
    await seed(1);
    await say('m1', 'ahoj');
    const s = { ...(await theSession()), requester_user_id: A };
    expect(await proposeItem(s, 'Cokoli.')).toEqual({ ok: false, reason: 'not_a_dm' });
    expect(await forgetOnRequest(s, 'all')).toBeNull();
  });

  it('with the flag off a DM proposal is refused', async () => {
    await seed(0, 0);
    await say('m1', 'ahoj');
    expect(await proposeItem(await theSession(), 'Cokoli.')).toEqual({ ok: false, reason: 'disabled' });
  });
});
