/**
 * Router wiring of the instant ack: opt-in flag, raw platform message id,
 * delay override. Real routeInbound; the reaction adapter is mocked.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-instant-ack' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import { wakeContainer } from './container-runner.js';
import { resetAckState, setAckAdapter } from './modules/ack/index.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-instant-ack';
const now = () => new Date().toISOString();

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

const react = vi.fn().mockResolvedValue(undefined);

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

async function seed(flags: { instant_ack?: number; ack_delay_ms?: number | null }): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({ id: 'ag-1', name: 'Klara', folder: 'klara', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
  await ensureContainerConfig('ag-1');
  await updateContainerConfigScalars('ag-1', flags);
}

async function inbound(id: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: 'testchat:C1:100.1',
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'G', senderId: 'U1', text: 'hi' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  setAckAdapter({ react });
});

afterEach(async () => {
  resetAckState();
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('router instant ack wiring', () => {
  it('flag off (default): the agent wakes, no reaction is ever made', async () => {
    await seed({});
    await inbound('1700000000.000100');
    await sleep(120);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(react).not.toHaveBeenCalled();
  });

  it('flag on: eyes on the RAW platform message id after ack_delay_ms', async () => {
    await seed({ instant_ack: 1, ack_delay_ms: 30 });
    await inbound('1700000000.000100');
    expect(react).not.toHaveBeenCalled();
    await sleep(150);
    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith(
      'testchat',
      'testchat:C1',
      'testchat:C1:100.1',
      'testchat',
      '1700000000.000100',
      'eyes',
      false,
    );
  });

  it('wake failure turns the pending ack into the warning', async () => {
    vi.mocked(wakeContainer).mockResolvedValueOnce(false);
    await seed({ instant_ack: 1, ack_delay_ms: 30 });
    await inbound('1700000000.000100');
    await sleep(150);
    expect(react.mock.calls.map((c) => c[5])).toEqual(['warning']);
  });
});
