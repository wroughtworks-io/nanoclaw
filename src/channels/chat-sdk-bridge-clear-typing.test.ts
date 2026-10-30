/**
 * Typing clear contract on the Chat SDK bridge: status '' means CLEAR — it
 * must reach the platform's clearTyping hook and must never fall through to
 * startTyping (which would re-start the indicator on Discord/Telegram/etc.).
 */
import { describe, expect, it, vi } from 'vitest';

import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { clearSlackStatus } from './slack.js';

function bridgeWith(clearTyping?: (threadId: string) => Promise<void>) {
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const adapter = { name: 'fake', startTyping } as unknown as Parameters<typeof createChatSdkBridge>[0]['adapter'];
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true, clearTyping });
  return { bridge, startTyping };
}

describe('bridge.setTyping clear', () => {
  it("status '' calls clearTyping with the thread id and never startTyping", async () => {
    const clearTyping = vi.fn().mockResolvedValue(undefined);
    const { bridge, startTyping } = bridgeWith(clearTyping);
    await bridge.setTyping!('slack:C1', 'slack:C1:100.1', '');
    expect(clearTyping).toHaveBeenCalledWith('slack:C1:100.1');
    expect(startTyping).not.toHaveBeenCalled();
  });

  it("status '' without a clearTyping hook is a silent no-op (no startTyping)", async () => {
    const { bridge, startTyping } = bridgeWith();
    await bridge.setTyping!('tg:1', null, '');
    expect(startTyping).not.toHaveBeenCalled();
  });

  it('normal typing still calls startTyping', async () => {
    const { bridge, startTyping } = bridgeWith(vi.fn());
    await bridge.setTyping!('slack:C1', 'slack:C1:100.1');
    expect(startTyping).toHaveBeenCalledWith('slack:C1:100.1');
  });
});

describe('clearSlackStatus', () => {
  it('sets an empty assistant status on the thread', async () => {
    const setAssistantStatus = vi.fn().mockResolvedValue(undefined);
    await clearSlackStatus({ setAssistantStatus } as never, 'slack:C1:100.1');
    expect(setAssistantStatus).toHaveBeenCalledWith('C1', '100.1', '');
  });

  it('skips ids with no thread ts and swallows API errors', async () => {
    const setAssistantStatus = vi.fn().mockRejectedValue(new Error('ratelimited'));
    await clearSlackStatus({ setAssistantStatus } as never, 'slack:C1');
    expect(setAssistantStatus).not.toHaveBeenCalled();
    await expect(clearSlackStatus({ setAssistantStatus } as never, 'slack:C1:100.1')).resolves.toBeUndefined();
  });
});
