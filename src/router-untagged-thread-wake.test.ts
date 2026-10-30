/**
 * mention-sticky must only stick to a thread where the agent was actually
 * addressed. An 'accumulate' wiring creates a per-thread session just to store
 * unmentioned messages as context; that session is NOT a subscription, so an
 * untagged reply in an untagged thread must never wake the agent.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring), mirroring auto-wired Slack channels (mention-sticky, accumulate,
 * per-thread, threads on).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-untagged-thread-wake' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-untagged-thread-wake';

function now(): string {
  return new Date().toISOString();
}

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

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedAutoWiredChannel(): Promise<void> {
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
}

/** Slack forms a top-level message's thread id from its own ts, so a reply shares it. */
async function inbound(id: string, threadId: string, isMention: boolean): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text: `msg ${id}` }),
      timestamp: now(),
      isMention,
      isGroup: true,
    },
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('mention-sticky only sticks to engaged threads', () => {
  it('untagged top-level, then untagged reply in its thread: stored as context, never wakes', async () => {
    await activate();
    await seedAutoWiredChannel();

    await inbound('m1', 'testchat:C1:100.1', false);
    await inbound('m2', 'testchat:C1:100.1', false);

    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('mention in a thread wakes, and an untagged follow-up then still wakes (existing sticky behaviour)', async () => {
    await activate();
    await seedAutoWiredChannel();

    await inbound('m1', 'testchat:C1:200.1', true);
    expect(wakeContainer).toHaveBeenCalledTimes(1);

    await inbound('m2', 'testchat:C1:200.1', false);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('a mention in a thread that only held stored context wakes, and engages it from then on', async () => {
    await activate();
    await seedAutoWiredChannel();

    await inbound('m1', 'testchat:C1:300.1', false);
    await inbound('m2', 'testchat:C1:300.1', false);
    expect(wakeContainer).not.toHaveBeenCalled();

    await inbound('m3', 'testchat:C1:300.1', true);
    expect(wakeContainer).toHaveBeenCalledTimes(1);

    await inbound('m4', 'testchat:C1:300.1', false);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('engagement is per thread: a mentioned thread does not make a sibling thread sticky', async () => {
    await activate();
    await seedAutoWiredChannel();

    await inbound('m1', 'testchat:C1:400.1', true);
    expect(wakeContainer).toHaveBeenCalledTimes(1);

    await inbound('m2', 'testchat:C1:500.1', false);
    await inbound('m3', 'testchat:C1:500.1', false);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('context-only sessions carry no engaged_at; waking sessions do', async () => {
    await activate();
    await seedAutoWiredChannel();
    const { findSessionForAgent } = await import('./db/sessions.js');

    await inbound('m1', 'testchat:C1:600.1', false);
    const ctx = await findSessionForAgent('ag-1', 'mg-1', 'testchat:C1:600.1');
    expect(ctx).toBeDefined();
    expect((await getSession(ctx!.id))!.engaged_at).toBeNull();

    await inbound('m2', 'testchat:C1:600.1', true);
    expect((await getSession(ctx!.id))!.engaged_at).toBeTruthy();
  });
});
