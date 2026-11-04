/**
 * The agent's own @-tag reaches it as a name.
 *
 * The Slack SDK resolves every inline mention to a display name except the
 * bot's own (kept as "@<botUserId>" for mention detection), so an agent
 * tagged as "@Klára" saw "@U0BNJV30DKK" and did not recognise itself
 * (production, 2026-11-04). The bridge rewrites the own tag via the
 * adapter's resolveSelfName hook. Driven through the real bridge path, as in
 * chat-sdk-bridge-inbound-policy.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { selfNameResolver } from './slack.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

function makeStubAdapter(botUserId?: string): { adapter: Adapter; chat: () => ChatDriver } {
  let captured: ChatDriver | null = null;
  const adapter = {
    name: 'selftest',
    botUserId,
    initialize: async (chat: ChatDriver) => {
      captured = chat;
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;
  return { adapter, chat: () => captured! };
}

let n = 0;
function makeMessage(text: string): Record<string, unknown> {
  const payload = { id: `m-${++n}`, text, author: { userId: 'U-T', fullName: 'Tereza', isBot: false, isMe: false } };
  return {
    ...payload,
    attachments: [],
    isMention: false,
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw: undefined,
    toJSON: () => ({ ...payload }),
  };
}

async function textSeen(opts: {
  botUserId?: string;
  resolveSelfName?: () => Promise<string | null>;
  text: string;
}): Promise<string> {
  const { adapter, chat } = makeStubAdapter(opts.botUserId);
  const calls: InboundMessage[] = [];
  const host: ChannelSetup = {
    onInbound: (_p, _t, message) => {
      calls.push(message);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true, resolveSelfName: opts.resolveSelfName });
  await bridge.setup(host);
  await chat().processMessage(adapter, 'selftest:C1:T1', makeMessage(opts.text));
  await bridge.teardown();
  return (calls[0]!.content as Record<string, unknown>).text as string;
}

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

describe('own @-tag rewritten to the agent name', () => {
  it('rewrites every occurrence of the own tag; other mentions untouched', async () => {
    const text = await textSeen({
      botUserId: 'UBOT',
      resolveSelfName: async () => 'Klára',
      text: '@UBOT ahoj, @UBOT řekni @Pavel Novák co umíš',
    });
    expect(text).toBe('@Klára ahoj, @Klára řekni @Pavel Novák co umíš');
  });

  it('leaves text unchanged when the name is unknown, the lookup throws, or no hook is set', async () => {
    expect(await textSeen({ botUserId: 'UBOT', resolveSelfName: async () => null, text: '@UBOT hi' })).toBe('@UBOT hi');
    expect(
      await textSeen({
        botUserId: 'UBOT',
        resolveSelfName: async () => {
          throw new Error('slack down');
        },
        text: '@UBOT hi',
      }),
    ).toBe('@UBOT hi');
    expect(await textSeen({ botUserId: 'UBOT', text: '@UBOT hi' })).toBe('@UBOT hi');
  });

  it('does not call the lookup when the message has no own tag', async () => {
    const resolve = vi.fn(async () => 'Klára');
    expect(await textSeen({ botUserId: 'UBOT', resolveSelfName: resolve, text: 'ahoj' })).toBe('ahoj');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('selfNameResolver (Slack users.info)', () => {
  const ok = (user: object) => ({ json: async () => ({ ok: true, user }) }) as unknown as Response;

  it('prefers the profile display name, memoises it, and sends the bot token', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ name: 'klara', real_name: 'Klára Real', profile: { display_name: 'Klára' } }),
    );
    const resolve = selfNameResolver('xoxb-test', () => 'UBOT', fetchImpl as unknown as typeof fetch);
    expect(await resolve()).toBe('Klára');
    expect(await resolve()).toBe('Klára');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('user=UBOT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test');
  });

  it('falls back to real name, and does not cache a failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'ratelimited' }) })
      .mockResolvedValueOnce(ok({ name: 'klara', real_name: 'Klára', profile: { display_name: '' } }));
    const resolve = selfNameResolver('xoxb-test', () => 'UBOT', fetchImpl as unknown as typeof fetch);
    expect(await resolve()).toBeNull();
    expect(await resolve()).toBe('Klára');
  });

  it('returns null before the adapter knows its own user id', async () => {
    const fetchImpl = vi.fn();
    expect(await selfNameResolver('xoxb-test', () => undefined, fetchImpl as unknown as typeof fetch)()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
