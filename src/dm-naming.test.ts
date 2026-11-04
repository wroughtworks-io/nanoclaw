import { describe, expect, it } from 'vitest';

import { dmName, dmNameFromInbound } from './dm-naming.js';
import { normalizeName } from './modules/agent-to-agent/db/agent-destinations.js';

describe('DM naming', () => {
  it('names a DM after the person', () => {
    expect(dmName('Tereza Bartoňová')).toBe('DM Tereza Bartoňová');
    expect(dmName('  ')).toBeNull();
    expect(dmName(null)).toBeNull();
  });

  it('reads the person from chat-sdk and native inbound shapes', () => {
    expect(dmNameFromInbound(JSON.stringify({ author: { userId: 'U1', fullName: 'Pavel Novák' } }), 'slack')).toBe(
      'DM Pavel Novák',
    );
    expect(dmNameFromInbound(JSON.stringify({ senderId: 'U1', senderName: 'Pavel Novák' }), 'slack')).toBe(
      'DM Pavel Novák',
    );
    expect(dmNameFromInbound(JSON.stringify({ senderId: 'U1' }), 'slack')).toBeNull();
    expect(dmNameFromInbound('not json', 'slack')).toBeNull();
  });

  it('gives a readable destination address, transliterating Czech', () => {
    expect(normalizeName('DM Tereza Bartoňová')).toBe('dm-tereza-bartonova');
    expect(normalizeName('DM Řehoř Žďárský')).toBe('dm-rehor-zdarsky');
    expect(normalizeName('d_bacherovky')).toBe('d-bacherovky'); // unchanged for ASCII names
  });
});
