/**
 * Session requester (Notion broker contract v1): set at creation for DM
 * sessions only, backfilled on a later inbound, never overwritten.
 * Exercised through the real routeInbound path.
 */
import fs from 'fs';
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

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-requester' };
});

const TEST_DIR = '/tmp/nanoclaw-test-router-requester';
const now = () => new Date().toISOString();

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

async function seed(isGroup: 0 | 1, sessionMode: 'shared' | 'per-thread' | 'agent-shared'): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
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
    session_mode: sessionMode,
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

let sender: string | null = 'testchat:U1';
async function inbound(id: string, threadId: string | null = null): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'X', senderId: 'U1', text: 'hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  });
}

async function requesters(): Promise<(string | null)[]> {
  const rows = await getDb().all<{ requester_user_id: string | null }>(
    'SELECT requester_user_id FROM sessions ORDER BY created_at, id',
  );
  return rows.map((r) => r.requester_user_id);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  sender = 'testchat:U1';
  setSenderResolver(async () => sender);
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('session requester', () => {
  it('a DM session records the sender', async () => {
    await seed(0, 'shared');
    await inbound('m1');
    expect(await requesters()).toEqual(['testchat:U1']);
  });

  it('a DM sub-thread session still records the sender (is_group, not threadId, decides)', async () => {
    await seed(0, 'per-thread');
    await inbound('m1', 'testchat:C1:171');
    expect(await requesters()).toEqual(['testchat:U1']);
  });

  it('a group session never records a requester', async () => {
    await seed(1, 'shared');
    await inbound('m1');
    expect(await requesters()).toEqual([null]);
  });

  it('an agent-shared session never records a requester, even from a DM', async () => {
    await seed(0, 'agent-shared');
    await inbound('m1');
    expect(await requesters()).toEqual([null]);
  });

  it('backfills an existing DM session whose requester is NULL on the next inbound', async () => {
    await seed(0, 'shared');
    sender = null; // unresolvable sender at creation
    await inbound('m1');
    expect(await requesters()).toEqual([null]);
    sender = 'testchat:U1';
    await inbound('m2');
    expect(await requesters()).toEqual(['testchat:U1']);
  });

  it('never overwrites a non-null requester with a different user', async () => {
    await seed(0, 'shared');
    await inbound('m1');
    sender = 'testchat:U2';
    await inbound('m2');
    expect(await requesters()).toEqual(['testchat:U1']);
  });
});
