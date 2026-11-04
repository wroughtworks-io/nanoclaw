import { describe, expect, it } from 'vitest';

import { isAutoLocalName, planDmBackfill, planToCommands } from './dm-backfill.js';

const taken = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

describe('DM backfill plan', () => {
  it('recognises only auto-minted destination names', () => {
    expect(isAutoLocalName('slack-mg-17915')).toBe(true);
    expect(isAutoLocalName('slack-mg-17915-2')).toBe(true);
    expect(isAutoLocalName('dm-tereza-bartonova')).toBe(false);
    expect(isAutoLocalName('d-bacherovky')).toBe(false);
  });

  it('names an unnamed DM and renames its auto destination; add before remove', () => {
    const plans = planDmBackfill(
      [
        {
          id: 'mg-1',
          name: null,
          personName: 'Pavel Novák',
          destinations: [{ agentGroupId: 'ag-k', localName: 'slack-mg-17927-2' }],
        },
      ],
      taken({ 'ag-k': ['slack-mg-17927-2', 'd-bacherovky'] }),
    );
    expect(plans).toEqual([
      {
        mgId: 'mg-1',
        setName: 'DM Pavel Novák',
        renames: [{ agentGroupId: 'ag-k', from: 'slack-mg-17927-2', to: 'dm-pavel-novak' }],
      },
    ]);
    expect(planToCommands(plans).map((c) => c.slice(0, 2).join(' '))).toEqual([
      'messaging-groups update',
      'destinations add',
      'destinations remove',
    ]);
  });

  it('keeps an existing name and hand-made destinations; renames only auto ones', () => {
    const plans = planDmBackfill(
      [
        {
          id: 'mg-t',
          name: 'DM Tereza Bartoňová',
          personName: null,
          destinations: [{ agentGroupId: 'ag-k', localName: 'dm-tereza-bartonova' }],
        },
        {
          id: 'mg-r',
          name: 'DM René Napravil',
          personName: null,
          destinations: [{ agentGroupId: 'ag-v', localName: 'slack-mg-17928' }],
        },
      ],
      taken({}),
    );
    expect(plans).toEqual([
      {
        mgId: 'mg-r',
        setName: null,
        renames: [{ agentGroupId: 'ag-v', from: 'slack-mg-17928', to: 'dm-rene-napravil' }],
      },
    ]);
  });

  it('never collides: existing names and two people with the same name get suffixes per agent group', () => {
    const plans = planDmBackfill(
      [
        {
          id: 'a',
          name: null,
          personName: 'Jan Novák',
          destinations: [{ agentGroupId: 'ag', localName: 'slack-mg-1' }],
        },
        {
          id: 'b',
          name: null,
          personName: 'Jan Novák',
          destinations: [{ agentGroupId: 'ag', localName: 'slack-mg-2' }],
        },
      ],
      taken({ ag: ['slack-mg-1', 'slack-mg-2', 'dm-jan-novak'] }),
    );
    expect(plans.flatMap((p) => p.renames.map((r) => r.to))).toEqual(['dm-jan-novak-2', 'dm-jan-novak-3']);
  });

  it('skips a DM whose person is unknown and emits no command for it', () => {
    const plans = planDmBackfill(
      [{ id: 'x', name: null, personName: null, destinations: [{ agentGroupId: 'ag', localName: 'slack-mg-9' }] }],
      taken({}),
    );
    expect(plans).toEqual([{ mgId: 'x', setName: null, renames: [], skipped: 'person unknown' }]);
    expect(planToCommands(plans)).toEqual([]);
  });
});
