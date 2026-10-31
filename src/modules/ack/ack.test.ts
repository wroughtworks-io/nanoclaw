import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  DEFAULT_ACK_DELAY_MS,
  MAX_ACK_AGE_MS,
  failAck,
  resetAckState,
  resolveAck,
  setAckAdapter,
  startAck,
  sweepPersistedAcks,
} from './index.js';

type Call = { emoji: string; remove: boolean; messageId: string; threadId: string | null; platformId: string };
let calls: Call[];
let react: ReturnType<typeof vi.fn>;

function install(impl?: (c: Call) => Promise<void>): void {
  calls = [];
  react = vi.fn(async (_ct, platformId, threadId, _inst, messageId, emoji, remove) => {
    const c = { emoji, remove: !!remove, messageId, threadId, platformId };
    calls.push(c);
    await impl?.(c);
  });
  setAckAdapter({ react: react as unknown as NonNullable<Parameters<typeof setAckAdapter>[0]['react']> });
}

const base = { sessionId: 's1', channelType: 'slack', platformId: 'slack:C1', threadId: 'slack:C1:1.1' };
const pending = async () => (await getDb().all('SELECT * FROM pending_acks')).length;

beforeEach(async () => {
  vi.useFakeTimers();
  await runMigrations(await initTestDb());
  install();
});

afterEach(async () => {
  resetAckState();
  vi.useRealTimers();
  await closeDb();
});

describe('instant ack', () => {
  it('fires eyes after the default delay, on the given message, and persists it', async () => {
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([
      { emoji: 'eyes', remove: false, messageId: 'm1', threadId: 'slack:C1:1.1', platformId: 'slack:C1' },
    ]);
    expect(await pending()).toBe(1);
  });

  it('honours a per-agent delay override', async () => {
    startAck({ ...base, messageId: 'm1', delayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
  });

  it('is skipped when a reply is delivered before the delay', async () => {
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(1000);
    resolveAck('s1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    expect(await pending()).toBe(0);
  });

  it('a reply for an earlier turn does not cancel a later message ack', async () => {
    startAck({ ...base, messageId: 'm1' });
    resolveAck('s1');
    startAck({ ...base, messageId: 'm2' });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
    expect(calls.map((c) => c.messageId)).toEqual(['m2']);
  });

  it('removes eyes on the first delivery and forgets the row', async () => {
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
    resolveAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ emoji: 'eyes', remove: true, messageId: 'm1' });
    expect(await pending()).toBe(0);
    resolveAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });

  it('tracks every pending ack in a session and resolves all of them', async () => {
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(1500);
    startAck({ ...base, messageId: 'm2' });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls.filter((c) => !c.remove).map((c) => c.messageId)).toEqual(['m1', 'm2']);
    resolveAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(
      calls
        .filter((c) => c.remove)
        .map((c) => c.messageId)
        .sort(),
    ).toEqual(['m1', 'm2']);
  });

  it('turns eyes into the warning when the container finishes without a reply', async () => {
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
    failAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1)).toMatchObject([
      { emoji: 'eyes', remove: true },
      { emoji: 'warning', remove: false },
    ]);
  });

  it('shows the warning directly when the wake fails before the delay', async () => {
    startAck({ ...base, messageId: 'm1' });
    failAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toMatchObject([{ emoji: 'warning', remove: false }]);
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS * 2);
    expect(calls).toHaveLength(1);
  });

  it('a late reply clears the warning', async () => {
    startAck({ ...base, messageId: 'm1' });
    failAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    resolveAck('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ emoji: 'warning', remove: true });
    expect(await pending()).toBe(0);
  });

  it('a reply racing the in-flight add still ends with eyes removed', async () => {
    let release!: () => void;
    install((c) => (c.emoji === 'eyes' && !c.remove ? new Promise<void>((r) => (release = r)) : Promise.resolve()));
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
    resolveAck('s1');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ emoji: 'eyes', remove: true });
    expect(await pending()).toBe(0);
  });

  it('clears (does not warn) at max age', async () => {
    startAck({ ...base, messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(MAX_ACK_AGE_MS);
    expect(calls.at(-1)).toMatchObject({ emoji: 'eyes', remove: true });
    expect(calls.some((c) => c.emoji === 'warning')).toBe(false);
    expect(await pending()).toBe(0);
  });

  it('works in a DM (threadId null)', async () => {
    startAck({ ...base, threadId: null, platformId: 'slack:D1', messageId: 'm1' });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
    expect(calls[0]).toMatchObject({ threadId: null, platformId: 'slack:D1', emoji: 'eyes' });
  });

  it('ignores a missing platform message id', async () => {
    startAck({ ...base, messageId: undefined });
    await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS * 2);
    expect(calls).toEqual([]);
  });

  describe('errors are best-effort', () => {
    it('an add failure never throws and leaves nothing behind', async () => {
      install(async () => {
        throw new Error('ratelimited');
      });
      startAck({ ...base, messageId: 'm1' });
      await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
      expect(await pending()).toBe(0);
      expect(() => resolveAck('s1')).not.toThrow();
      expect(() => failAck('s1')).not.toThrow();
    });

    it('already_reacted counts as success; no_reaction on remove too', async () => {
      install(async (c) => {
        throw new Error(c.remove ? 'An API error occurred: no_reaction' : 'An API error occurred: already_reacted');
      });
      startAck({ ...base, messageId: 'm1' });
      await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
      expect(await pending()).toBe(1);
      resolveAck('s1');
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending()).toBe(0);
    });

    it('an adapter without react support is tolerated', async () => {
      setAckAdapter({});
      startAck({ ...base, messageId: 'm1' });
      await vi.advanceTimersByTimeAsync(DEFAULT_ACK_DELAY_MS);
      expect(await pending()).toBe(0);
    });
  });
});

describe('restart sweep', () => {
  async function seed(state: string, ageMs: number, id: string) {
    await getDb().run(
      `INSERT INTO pending_acks (session_id, message_id, channel_type, platform_id, thread_id, instance, state, created_at)
       VALUES ('old', ?, 'slack', 'slack:C1', NULL, NULL, ?, ?)`,
      id,
      state,
      Date.now() - ageMs,
    );
  }

  it('removes leftover eyes, warns when older than max age, forgets warnings, empties the table', async () => {
    await seed('eyes', 60_000, 'fresh');
    await seed('eyes', MAX_ACK_AGE_MS + 60_000, 'stale');
    await seed('warning', 60_000, 'warned');
    expect(await sweepPersistedAcks()).toBe(3);
    const byId = (id: string) =>
      calls.filter((c) => c.messageId === id).map((c) => `${c.emoji}${c.remove ? '-' : '+'}`);
    expect(byId('fresh')).toEqual(['eyes-']);
    expect(byId('stale')).toEqual(['eyes-', 'warning+']);
    expect(byId('warned')).toEqual([]);
    expect(await pending()).toBe(0);
  });

  it('deletes the row even when the platform call fails, and never throws', async () => {
    install(async () => {
      throw new Error('boom');
    });
    await seed('eyes', 1000, 'x');
    await expect(sweepPersistedAcks()).resolves.toBe(1);
    expect(await pending()).toBe(0);
  });
});
