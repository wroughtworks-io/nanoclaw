/**
 * One-time backfill: name existing DMs "DM <person>" and give their
 * auto-generated destinations readable addresses.
 *
 * DMs auto-created before src/dm-naming.ts have no name, so agents see them
 * only as "slack-mg-…" destinations. Planning is pure (this file) so it can
 * be tested and reviewed as a dry run; scripts/name-dms.ts gathers the rows
 * and applies the plan through `ncl`, keeping the host the single writer.
 * Uses the same naming rules as the live path (dmName, normalizeName).
 */
import { dmName } from './dm-naming.js';
import { normalizeName } from './modules/agent-to-agent/db/agent-destinations.js';

export interface DmRow {
  id: string;
  /** Current messaging_groups.name. */
  name: string | null;
  /** The person on the other end, if it could be resolved. */
  personName: string | null;
  destinations: Array<{ agentGroupId: string; localName: string }>;
}

export interface DmPlan {
  mgId: string;
  /** New messaging-group name to set; null when it already has one. */
  setName: string | null;
  renames: Array<{ agentGroupId: string; from: string; to: string }>;
  /** Why nothing could be done for this DM. */
  skipped?: string;
}

/** Destination names minted by createMessagingGroupAgent for an unnamed group. */
export function isAutoLocalName(localName: string): boolean {
  return /^[a-z0-9]+-mg-[a-z0-9]+(-\d+)?$/.test(localName);
}

/**
 * @param taken every local_name currently in use, per agent group — renames
 *   must not collide with them (or with each other).
 */
export function planDmBackfill(dms: DmRow[], taken: Map<string, Set<string>>): DmPlan[] {
  const used = new Map([...taken].map(([ag, names]) => [ag, new Set(names)]));
  const plans: DmPlan[] = [];
  for (const dm of dms) {
    const setName = dm.name ? null : dmName(dm.personName);
    const finalName = dm.name ?? setName;
    const auto = dm.destinations.filter((d) => isAutoLocalName(d.localName));
    if (!finalName) {
      if (auto.length > 0 || !dm.name)
        plans.push({ mgId: dm.id, setName: null, renames: [], skipped: 'person unknown' });
      continue;
    }
    const renames = auto.map((d) => {
      const names = used.get(d.agentGroupId) ?? new Set<string>();
      used.set(d.agentGroupId, names);
      const base = normalizeName(finalName);
      let to = base;
      for (let i = 2; names.has(to); i++) to = `${base}-${i}`;
      names.add(to);
      return { agentGroupId: d.agentGroupId, from: d.localName, to };
    });
    if (setName || renames.length > 0) plans.push({ mgId: dm.id, setName, renames });
  }
  return plans;
}

/** The plan as the exact `ncl` commands --apply will run, for the dry-run printout. */
export function planToCommands(plans: DmPlan[]): string[][] {
  const cmds: string[][] = [];
  for (const p of plans) {
    if (p.skipped) continue;
    if (p.setName) cmds.push(['messaging-groups', 'update', p.mgId, '--name', p.setName]);
    for (const r of p.renames) {
      // No rename verb: add the new name first, then remove the old one, so
      // the destination is never missing.
      cmds.push([
        'destinations',
        'add',
        '--agent-group-id',
        r.agentGroupId,
        '--local-name',
        r.to,
        '--target-type',
        'channel',
        '--target-id',
        p.mgId,
      ]);
      cmds.push(['destinations', 'remove', '--agent-group-id', r.agentGroupId, '--local-name', r.from]);
    }
  }
  return cmds;
}
