/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { pauseTypingRefreshAfterDelivery, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('typing indicator is always cleared when the turn ends', () => {
  function adapterWithClears() {
    const fired: string[] = [];
    const cleared: Array<{ platformId: string; threadId: string | null; instance?: string }> = [];
    setTypingAdapter({
      async setTyping(_channelType, platformId, threadId, instance, status) {
        if (status === '') cleared.push({ platformId, threadId, instance });
        else fired.push(platformId);
      },
    });
    return { fired, cleared };
  }

  it('no output: grace expires with a stale heartbeat -> refresher stops AND clears the indicator', async () => {
    const { cleared } = adapterWithClears();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(30_000); // no heartbeat file ever exists
    expect(cleared).toEqual([{ platformId: 'slack:C1', threadId: 'T1', instance: 'slack-tester' }]);

    // Refresher is gone: no further fires or clears.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cleared).toHaveLength(1);
  });

  it('stopTypingRefresh (container exit / error / failed wake) clears the indicator', async () => {
    const { cleared } = adapterWithClears();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(cleared).toEqual([{ platformId: 'slack:C1', threadId: 'T1', instance: 'slack-tester' }]);
  });

  it('stopTypingRefresh with no active refresher does not clear anything', async () => {
    const { cleared } = adapterWithClears();
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(cleared).toHaveLength(0);
  });

  it('after a reply is delivered, typing does not re-fire inside the startup grace (would stick after the reply)', async () => {
    const { fired, cleared } = adapterWithClears();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(1_000);
    pauseTypingRefreshAfterDelivery('sess-1'); // fast reply
    fired.length = 0;

    // Pause (10s) ends at ~11s, inside the 15s grace from start. Previously a
    // tick here re-set the status after the reply posted.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fired).toHaveLength(0);
    expect(cleared).toHaveLength(1);
  });

  it('a new inbound after a delivery restores the grace window', async () => {
    const { fired } = adapterWithClears();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(1_000);
    pauseTypingRefreshAfterDelivery('sess-1');
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    fired.length = 0;
    await vi.advanceTimersByTimeAsync(8_500);
    expect(fired.length).toBeGreaterThanOrEqual(2);
  });

  it('a throwing adapter never breaks stop', async () => {
    setTypingAdapter({
      async setTyping(_c, _p, _t, _i, status) {
        if (status === '') throw new Error('slack down');
      },
    });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    expect(() => stopTypingRefresh('sess-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});
