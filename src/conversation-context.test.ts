/**
 * Conversation context on mention: budget/render unit tests, the Slack fetcher
 * (Chat SDK adapter mocked), and the REAL routeInbound path with the setting
 * on/off, full-thread injection, fail-soft, and the untagged-doesn't-wake regression.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-conversation-context' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  ensureContainerConfig,
  updateContainerConfigScalars,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ConversationContext,
  ConversationContextMessage,
  ConversationContextRequest,
} from './channels/adapter.js';
import { fetchSlackConversationContext } from './channels/slack.js';
import { omittedMarker, renderContextBlock, selectWithinBudget } from './conversation-context.js';
import { findSessionForAgent } from './db/sessions.js';
import { wakeContainer } from './container-runner.js';
import { routeInbound } from './router.js';
import { parseIsoTimestamp } from './mailbox/model.js';
import { withExistingMailboxSession } from './session-manager.js';
import { log } from './log.js';

const TEST_DIR = '/tmp/nanoclaw-test-conversation-context';
const now = (): string => new Date().toISOString();

function msg(i: number, over: Partial<ConversationContextMessage> = {}): ConversationContextMessage {
  return {
    id: `${1000 + i}.000100`,
    sender: `User${i}`,
    isSelf: false,
    text: `message number ${i}`,
    timestamp: new Date(Date.UTC(2026, 9, 31, 8, i)).toISOString(),
    ...over,
  };
}
const many = (n: number): ConversationContextMessage[] => Array.from({ length: n }, (_, i) => msg(i));

describe('selectWithinBudget / renderContextBlock', () => {
  it('a thread over 10 messages yields the full context when within budget', () => {
    const r = renderContextBlock('thread', many(25))!;
    expect(r.kept).toHaveLength(25);
    expect(r.text).toContain('<slack_context source="thread">');
    expect(r.text).toContain('Background only');
    expect(r.text).toContain('message number 0');
    expect(r.text).toContain('message number 24');
    expect(r.text).not.toContain('vynecháno');
  });

  it('over the message budget: keeps root + newest, adds the marker', () => {
    const all = many(80);
    const { lines, omitted, kept } = selectWithinBudget(all, 'thread', { maxMessages: 50 });
    expect(kept).toHaveLength(50);
    expect(kept[0].id).toBe(all[0].id); // root
    expect(kept.at(-1)!.id).toBe(all[79].id); // newest
    expect(kept[1].id).toBe(all[31].id); // 49 newest after the root: 31..79
    expect(omitted).toBe(30);
    expect(lines[0]).toContain('message number 0');
    expect(lines[1]).toBe(omittedMarker(30));
    expect(lines[1]).toBe('(30 starších zpráv vynecháno)');
  });

  it('over the token budget (chars/4): keeps root + newest, adds the marker', () => {
    const big = Array.from({ length: 20 }, (_, i) => msg(i, { text: `${i}:` + 'x'.repeat(1000) }));
    const { lines, omitted, kept } = selectWithinBudget(big, 'thread', { maxTokens: 1000 });
    expect(kept[0].id).toBe(big[0].id);
    expect(kept.at(-1)!.id).toBe(big[19].id);
    expect(omitted).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain(omittedMarker(omitted));
    expect(lines.join('\n').length / 4).toBeLessThanOrEqual(1000);
  });

  it('channel context has no root pinning; marks the agent’s own messages', () => {
    const all = [...many(5), msg(5, { isSelf: true, sender: 'Klára' })];
    const { lines, kept } = selectWithinBudget(all, 'channel', { maxMessages: 3 });
    expect(kept.map((m) => m.id)).toEqual([all[3].id, all[4].id, all[5].id]);
    expect(lines[0]).toBe(omittedMarker(3));
    expect(lines.at(-1)).toContain('you (Klára)');
  });

  it('returns null for an empty result', () => {
    expect(renderContextBlock('channel', [])).toBeNull();
  });
});

describe('fetchSlackConversationContext (Chat SDK adapter mocked)', () => {
  const sdk = (ts: string, text: string, isMe = false, date = new Date(Number(ts) * 1000)) => ({
    id: ts,
    text,
    author: { userId: 'U1', fullName: 'Jana', userName: 'jana', isMe },
    metadata: { dateSent: date },
  });
  const decodeThreadId = (id: string) => {
    const [, channel, threadTs] = id.split(':');
    return { channel, threadTs };
  };

  it('thread reply: newest window before the trigger, plus the root fetched separately when outside the window', async () => {
    const fetchMessages = vi.fn(async (_id: string, o: { direction?: string }) =>
      o.direction === 'forward'
        ? { messages: [sdk('100.000000', 'root')] }
        : { messages: [sdk('150.000000', 'newer'), sdk('151.000000', 'newest', true)] },
    );
    const fetchChannelMessages = vi.fn();
    const r = await fetchSlackConversationContext({ fetchMessages, fetchChannelMessages, decodeThreadId } as never, {
      platformId: 'slack:C1',
      threadId: 'slack:C1:100.000000',
      messageId: '160.000000',
    });
    expect(r.source).toBe('thread');
    expect(r.messages.map((m) => m.text)).toEqual(['root', 'newer', 'newest']);
    expect(r.messages[2].isSelf).toBe(true);
    expect(fetchMessages.mock.calls[0][1]).toMatchObject({ direction: 'backward', limit: 50, cursor: '160.000000' });
    expect(fetchChannelMessages).not.toHaveBeenCalled();
  });

  it('top-level mention (thread ts == own ts): channel history, 24 h window, trigger excluded', async () => {
    const t = 1_800_000_000;
    const fetchChannelMessages = vi.fn(async () => ({
      messages: [
        sdk(String(t - 2 * 86400), 'two days ago'),
        sdk(String(t - 3600), 'an hour ago'),
        sdk(String(t), 'the trigger itself'),
      ],
    }));
    const r = await fetchSlackConversationContext(
      { fetchMessages: vi.fn(), fetchChannelMessages, decodeThreadId } as never,
      { platformId: 'slack:C1', threadId: `slack:C1:${t}`, messageId: String(t) },
    );
    expect(r.source).toBe('channel');
    expect(r.messages.map((m) => m.text)).toEqual(['an hour ago']);
    expect(fetchChannelMessages).toHaveBeenCalledWith('slack:C1', expect.objectContaining({ limit: 30 }));
  });

  it('propagates Slack errors (the host fails soft)', async () => {
    const fetchMessages = vi.fn().mockRejectedValue(new Error('missing_scope'));
    await expect(
      fetchSlackConversationContext({ fetchMessages, fetchChannelMessages: vi.fn(), decodeThreadId } as never, {
        platformId: 'slack:C1',
        threadId: 'slack:C1:100.000000',
        messageId: '160.000000',
      }),
    ).rejects.toThrow('missing_scope');
  });
});

// ── Router integration ──────────────────────────────────────────────────────

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

let fetchContext: Mock<(req: ConversationContextRequest) => Promise<ConversationContext>>;

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
    fetchConversationContext: (req) => fetchContext(req),
  };
}

async function seed(settingOn: boolean): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({ id: 'ag-1', name: 'Klara', folder: 'klara', agent_provider: null, created_at: now() });
  await ensureContainerConfig('ag-1');
  if (settingOn) await updateContainerConfigScalars('ag-1', { slack_context_fetch: 1 });
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

async function inbound(id: string, threadId: string, isMention: boolean): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ id, sender: 'Gavriel', senderId: 'U1', text: `msg ${id}` }),
      timestamp: now(),
      isMention,
      isGroup: true,
    },
  });
}

async function sessionRows(threadId: string): Promise<Array<{ kind: string; content: Record<string, unknown> }>> {
  const s = await findSessionForAgent('ag-1', 'mg-1', threadId);
  expect(s).toBeDefined();
  const rows = await withExistingMailboxSession('ag-1', s!.id, (mb) => mb.getInboundHistory(500));
  return (rows ?? []).reverse().map((r) => ({ kind: r.kind, content: JSON.parse(r.content) }));
}
const contextRows = async (threadId: string) =>
  (await sessionRows(threadId)).filter((r) => String(r.content.text ?? '').startsWith('<slack_context'));

async function pendingRows(threadId: string) {
  const s = (await findSessionForAgent('ag-1', 'mg-1', threadId))!;
  const rows = await withExistingMailboxSession('ag-1', s.id, (mb) => mb.getInboundDeliveryState(500));
  return (rows ?? []).filter((r) => r.status === 'pending');
}

const ctx = (source: 'thread' | 'channel', messages: ConversationContextMessage[]): ConversationContext => ({
  source,
  messages,
});

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fetchContext = vi.fn<(req: ConversationContextRequest) => Promise<ConversationContext>>();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('router: Slack context on mention', () => {
  it('thread mention with the setting on: one background row before the waking message, root predating the agent included', async () => {
    fetchContext.mockResolvedValue(ctx('thread', many(14)));
    await seed(true);
    await inbound('m-trigger', 'testchat:C1:900.1', true);

    expect(fetchContext).toHaveBeenCalledWith({
      platformId: 'testchat:C1',
      threadId: 'testchat:C1:900.1',
      messageId: 'm-trigger',
    });
    const rows = await sessionRows('testchat:C1:900.1');
    const block = rows.findIndex((r) => String(r.content.text).startsWith('<slack_context source="thread">'));
    const trigger = rows.findIndex((r) => r.content.id === 'm-trigger');
    expect(block).toBeGreaterThanOrEqual(0);
    expect(block).toBeLessThan(trigger); // rendered before the new message
    const text = String(rows[block].content.text);
    expect(text).toContain('message number 0'); // the root, which the agent never received
    expect(text).toContain('message number 13');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('top-level mention yields channel context', async () => {
    fetchContext.mockResolvedValue(ctx('channel', many(3)));
    await seed(true);
    await inbound('m-top', 'testchat:C1:m-top', true);
    const rows = await contextRows('testchat:C1:m-top');
    expect(rows).toHaveLength(1);
    expect(String(rows[0].content.text)).toContain('<slack_context source="channel">');
  });

  it('pending accumulated rows covered by the block are retired, not re-delivered', async () => {
    await seed(true);
    await inbound('1001.000100', 'testchat:C1:900.1', false);
    await inbound('1002.000100', 'testchat:C1:900.1', false);
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(fetchContext).not.toHaveBeenCalled(); // untagged: nothing fetched

    fetchContext.mockResolvedValue(ctx('thread', many(4))); // ids 1000..1003
    await inbound('m-trigger', 'testchat:C1:900.1', true);
    const rows = await contextRows('testchat:C1:900.1');
    expect(rows).toHaveLength(1);
    const text = String(rows[0].content.text);
    for (const i of [0, 1, 2, 3]) expect(text).toContain(`message number ${i}`);
    expect(rows[0].content.contextIds).toBeUndefined();
    // Only the context row and the mention remain deliverable.
    expect(await pendingRows('testchat:C1:900.1')).toHaveLength(2);
  });

  it('staging scenario: root + 10 untagged replies pending, then a mention, cap 10', async () => {
    await seed(true);
    const T = 'testchat:C1:1000.000100';
    const thread = many(11); // root + 10 replies, ids 1000..1010
    for (const m of thread) await inbound(m.id, T, false);
    expect(await pendingRows(T)).toHaveLength(11);

    fetchContext.mockResolvedValue(ctx('thread', thread));
    await inbound('m-mention', T, true);

    const rows = await contextRows(T);
    expect(rows).toHaveLength(1);
    const text = String(rows[0].content.text);
    expect(text).toContain('message number 0'); // the root
    expect(text).toContain('message number 1'); // the key first reply
    expect(text).toContain('message number 10');

    // What the container would poll (status=pending): one context row + the mention.
    const pending = await pendingRows(T);
    expect(pending).toHaveLength(2);
    const pendingContent = pending.map((r) => JSON.parse(r.content) as Record<string, unknown>);
    expect(pendingContent.some((c) => String(c.text ?? '').startsWith('<slack_context'))).toBe(true);
    expect(pendingContent.some((c) => c.id === 'm-mention')).toBe(true);
    expect(pending.filter((r) => r.trigger)).toHaveLength(1); // the mention still wakes
    expect(log.info).toHaveBeenCalledWith(
      'Conversation context injected',
      expect.objectContaining({ fetched: 11, kept: 11, omitted: 0, pendingRowsCovered: 11 }),
    );
  });

  it('re-mention after earlier turns (rows completed): the block holds ALL thread messages, own answer marked "you"', async () => {
    await seed(true);
    const T = 'testchat:C1:1000.000100';
    const thread = [...many(13)];
    thread[3] = msg(3, { isSelf: true, sender: 'Klára' }); // her earlier answer
    // Earlier turns: replies 1..3 were delivered and completed (session memory since lost).
    for (const i of [1, 2, 3]) await inbound(thread[i].id, T, false);
    const s = (await findSessionForAgent('ag-1', 'mg-1', T))!;
    const ids = (await withExistingMailboxSession('ag-1', s.id, (mb) => mb.getInboundDeliveryState(10)))!.map(
      (r) => r.id,
    );
    await withExistingMailboxSession('ag-1', s.id, (mb) => {
      mb.applyProcessingAcks(
        ids.map((messageId) => ({ messageId, status: 'completed', statusChanged: parseIsoTimestamp(now()) })),
      );
    });
    expect(await pendingRows(T)).toHaveLength(0);

    fetchContext.mockResolvedValue(ctx('thread', [...thread, msg(13)])); // 14 fetched incl. waking
    await inbound(msg(13).id, T, true);

    const rows = await contextRows(T);
    expect(rows).toHaveLength(1);
    const text = String(rows[0].content.text);
    for (let i = 0; i < 13; i++) expect(text).toContain(`message number ${i}`);
    expect(text).not.toContain('message number 13'); // the waking message itself is excluded
    expect(text).toContain('you (Klára)');
    expect(log.info).toHaveBeenCalledWith(
      'Conversation context injected',
      expect.objectContaining({ fetched: 14, kept: 13, omitted: 0, pendingRowsCovered: 0 }),
    );
  });

  it('a second mention re-sends the full thread and supersedes the still-pending earlier block', async () => {
    await seed(true);
    const T = 'testchat:C1:900.1';
    fetchContext.mockResolvedValue(ctx('thread', many(4)));
    await inbound('m-1', T, true);
    fetchContext.mockResolvedValue(ctx('thread', [...many(4), msg(9)]));
    await inbound('m-2', T, true);
    const rows = await contextRows(T);
    expect(rows).toHaveLength(2); // history keeps both rows...
    const latest = String(rows[1].content.text);
    for (const i of [0, 1, 2, 3, 9]) expect(latest).toContain(`message number ${i}`);
    // ...but only the newest block is still deliverable (no duplicate blocks in one prompt).
    const pending = (await pendingRows(T)).map((r) => JSON.parse(r.content) as Record<string, unknown>);
    expect(pending.filter((c) => String(c.text ?? '').startsWith('<slack_context'))).toHaveLength(1);
  });

  it('budget truncation: omitted pending rows are NOT retired and stay deliverable', async () => {
    await seed(true);
    const T = 'testchat:C1:1000.000100';
    const thread = many(8);
    for (const m of thread) await inbound(m.id, T, false);
    fetchContext.mockResolvedValue(ctx('thread', thread));
    const { injectConversationContext } = await import('./conversation-context.js');
    const s = (await findSessionForAgent('ag-1', 'mg-1', T))!;
    await injectConversationContext({
      adapter: { ...makeAdapter() },
      agentGroupId: 'ag-1',
      sessionId: s.id,
      platformId: 'testchat:C1',
      threadId: T,
      messageId: 'm-mention',
      messageTimestamp: now(),
      channelType: 'testchat',
      budget: { maxMessages: 4 },
    });
    const text = String((await contextRows(T))[0].content.text);
    expect(text).toContain(omittedMarker(4));
    expect(text).toContain('message number 0'); // root kept
    expect(text).not.toContain('message number 1');
    // 4 kept rows retired; the 4 omitted (1..4) stay pending, plus the block row.
    const pending = (await pendingRows(T)).map((r) => JSON.parse(r.content) as Record<string, unknown>);
    expect(
      pending
        .filter((c) => typeof c.id === 'string')
        .map((c) => c.id)
        .sort(),
    ).toEqual(thread.slice(1, 5).map((m) => m.id));
    expect(log.info).toHaveBeenCalledWith(
      'Conversation context injected',
      expect.objectContaining({ fetched: 8, kept: 4, omitted: 4, pendingRowsCovered: 4 }),
    );
  });

  it('logs why nothing was injected: nothing new, no adapter method', async () => {
    await seed(true);
    const T = 'testchat:C1:1000.000100';
    fetchContext.mockResolvedValue(ctx('thread', []));
    await inbound('m1', T, true);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('nothing to add'),
      expect.objectContaining({ fetched: 0 }),
    );
    const { injectConversationContext } = await import('./conversation-context.js');
    const base = {
      agentGroupId: 'ag-1',
      sessionId: 's',
      platformId: 'p',
      threadId: null,
      messageId: 'x',
      messageTimestamp: now(),
      channelType: 'testchat',
    };
    expect(await injectConversationContext({ ...base, adapter: undefined })).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no fetchConversationContext'), expect.anything());
  });

  it('fetch failure falls back to current behaviour without throwing', async () => {
    fetchContext.mockRejectedValue(new Error('not_in_channel'));
    await seed(true);
    await expect(inbound('m-trigger', 'testchat:C1:900.1', true)).resolves.toBeUndefined();
    expect(await contextRows('testchat:C1:900.1')).toHaveLength(0);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Conversation context fetch failed — continuing without it',
      expect.objectContaining({ err: 'not_in_channel' }),
    );
  });

  it('fetch failure leaves the pending accumulated rows untouched', async () => {
    await seed(true);
    const T = 'testchat:C1:900.1';
    for (const m of many(3)) await inbound(m.id, T, false);
    fetchContext.mockRejectedValue(new Error('ratelimited'));
    await inbound('m-trigger', T, true);
    expect(await contextRows(T)).toHaveLength(0);
    expect(await pendingRows(T)).toHaveLength(4); // 3 accumulated + the mention
  });

  it('a hung fetch times out (short timeout) and the message still delivers', async () => {
    fetchContext.mockReturnValue(new Promise(() => {}));
    await seed(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = inbound('m-trigger', 'testchat:C1:900.1', true);
      await vi.advanceTimersByTimeAsync(3100);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Conversation context fetch failed — continuing without it',
      expect.objectContaining({ err: expect.stringContaining('timed out') }),
    );
  });

  it('with the setting off (default), nothing is fetched', async () => {
    fetchContext.mockResolvedValue(ctx('thread', many(5)));
    await seed(false);
    await inbound('m-trigger', 'testchat:C1:900.1', true);
    expect(fetchContext).not.toHaveBeenCalled();
    expect(await contextRows('testchat:C1:900.1')).toHaveLength(0);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('regression: untagged messages still do not wake the agent, and never fetch', async () => {
    fetchContext.mockResolvedValue(ctx('thread', many(5)));
    await seed(true);
    await inbound('u1', 'testchat:C1:700.1', false);
    await inbound('u2', 'testchat:C1:700.1', false);
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(fetchContext).not.toHaveBeenCalled();
  });

  it('a sticky follow-up (no mention) after engagement does not re-fetch', async () => {
    fetchContext.mockResolvedValue(ctx('thread', many(3)));
    await seed(true);
    await inbound('m1', 'testchat:C1:800.1', true);
    await inbound('m2', 'testchat:C1:800.1', false);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
    expect(fetchContext).toHaveBeenCalledTimes(1);
  });
});
