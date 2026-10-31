/**
 * Production wiring for the opt-in Slack context fetch: the REAL slack.ts bridge factory, the REAL
 * channel registry (initChannelAdapters / getChannelAdapter, exactly as router.ts calls it), and the
 * REAL injectConversationContext. Only the Slack SDK client (network) is faked, one layer below the
 * bridge. Guards against the adapter returned by the registry losing `fetchConversationContext`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const fetchMessages = vi.fn();
vi.mock('@chat-adapter/slack', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@chat-adapter/slack');
  return {
    ...actual,
    createSlackAdapter: () => ({
      name: 'slack',
      fetchMessages,
      fetchChannelMessages: vi.fn(),
      decodeThreadId: (id: string) => {
        const [, channel, threadTs] = id.split(':');
        return { channel, threadTs };
      },
      fetchThread: vi.fn(),
      initialize: vi.fn(),
    }),
  };
});

const originalCwd = process.cwd();

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-ctx-wiring-'));
  writeFileSync(join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-test\n');
  process.chdir(dir);
});
afterAll(() => process.chdir(originalCwd));

describe('Slack context fetch: registry + bridge wiring', () => {
  it('getChannelAdapter("slack") exposes fetchConversationContext and it reaches the Slack client', async () => {
    const { createSlackBridge } = await import('./slack.js');
    const { registerChannelAdapter, initChannelAdapters, getChannelAdapter, teardownChannelAdapters } =
      await import('./channel-registry.js');
    const bridge = createSlackBridge()!;
    expect(bridge).not.toBeNull();
    // Real registry; the only stub is network-touching setup() on the otherwise-real bridge.
    bridge.setup = async () => ({}) as never;
    bridge.teardown = async () => {};
    registerChannelAdapter('slack', { factory: () => bridge });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
    try {
      const adapter = getChannelAdapter('slack');
      expect(adapter).toBeDefined();
      expect(typeof adapter!.fetchConversationContext).toBe('function');

      const sdk = (ts: string, text: string) => ({
        id: ts,
        text,
        author: { userId: 'U1', fullName: 'Jana', isMe: false },
        metadata: { dateSent: new Date(Number(ts) * 1000) },
      });
      fetchMessages.mockResolvedValue({ messages: [sdk('100.000000', 'root'), sdk('101.000000', 'reply 1')] });
      const ctx = await adapter!.fetchConversationContext!({
        platformId: 'slack:C1',
        threadId: 'slack:C1:100.000000',
        messageId: '120.000000',
      });
      expect(ctx.source).toBe('thread');
      expect(ctx.messages.map((m) => m.text)).toEqual(['root', 'reply 1']);
    } finally {
      await teardownChannelAdapters();
    }
  });
});
