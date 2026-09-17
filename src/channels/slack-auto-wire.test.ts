/**
 * Unit tests for the Slack auto-wire interceptor (Wroughtworks fork module).
 *
 * The module self-registers on the channel-card seam, so every case drives it
 * the way production does — through requestChannelApproval — and asserts on
 * what actually changed: a wiring row, the messaging group's sender gate, and
 * whether a card went out.
 *
 * Covers:
 *  - DM surface: unchanged behaviour (switch off → card; switch on → wired)
 *  - CHANNEL surface: off by default, so this module's original refusal to
 *    auto-wire rooms still holds when the new key is unset
 *  - CHANNEL surface: an admin's / owner's mention wires; a non-admin's does
 *    not; an unidentifiable sender does not
 *  - the two surfaces are independently switchable and never borrow each
 *    other's target
 *  - a wired channel takes Slack's DECLARED group semantics (mention-sticky,
 *    per-thread, threads honored) — not the DM stamp
 *  - both gates open: wiring + unknown_sender_policy → 'public'
 *  - idempotence on redelivery, and unknown target → card
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroup } from '../db/messaging-groups.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import type { InboundEvent } from './adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';

// Prevent any container work: the replay hop imports the router dynamically.
const routeInboundMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../router.js', () => ({ routeInbound: routeInboundMock }));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

vi.mock('../modules/permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../db/connection.js');
    return await getDb().get(
      `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      userId,
    );
  }),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-slack-auto-wire' };
});

const TEST_DIR = '/tmp/nanoclaw-test-slack-auto-wire';
const INSTANCE = 'slack-klara';
const DM_KEY = 'SLACK_DM_AUTO_WIRE_KLARA';
const CHANNEL_KEY = 'SLACK_CHANNEL_AUTO_WIRE_KLARA';

const now = () => new Date().toISOString();

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  // The agent this instance would wire to, plus a second one so "names no
  // group" is a real miss rather than an empty table.
  await createAgentGroup({ id: 'ag-klara', name: 'Klára', folder: 'klara', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-marta', name: 'Marta', folder: 'marta', agent_provider: null, created_at: now() });

  // An owner (approver), a scoped admin, and a plain colleague.
  for (const [id, name] of [
    ['slack:U_OWNER', 'Owner'],
    ['slack:U_ADMIN', 'Scoped Admin'],
    ['slack:U_STAFF', 'Colleague'],
  ]) {
    await upsertUser({ id, kind: 'slack', display_name: name, created_at: now() });
  }
  await grantRole({
    user_id: 'slack:U_OWNER',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await grantRole({
    user_id: 'slack:U_ADMIN',
    role: 'admin',
    agent_group_id: 'ag-klara',
    granted_by: null,
    granted_at: now(),
  });

  // The owner needs a reachable DM or the card path bails before delivering,
  // which would make "fell back to the card" unobservable.
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'slack',
    platform_id: 'slack:D_OWNER',
    instance: INSTANCE,
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`,
    'slack:U_OWNER',
    'slack',
    'mg-dm-owner',
    now(),
  );

  deliverMock.mockClear();
  routeInboundMock.mockClear();
  delete process.env[DM_KEY];
  delete process.env[CHANNEL_KEY];

  // Import for side effects: slack.js registers SLACK_DEFAULTS (so declared
  // group semantics resolve), slack-auto-wire.js registers the interceptor.
  await import('./slack.js');
  await import('./slack-auto-wire.js');
});

afterEach(async () => {
  delete process.env[DM_KEY];
  delete process.env[CHANNEL_KEY];
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function unwired(id: string, isGroup: boolean): Promise<MessagingGroup> {
  const mg: MessagingGroup = {
    id,
    channel_type: 'slack',
    platform_id: `slack:${isGroup ? 'C' : 'D'}${id}`,
    instance: INSTANCE,
    name: isGroup ? 'development-projekty-test' : null,
    is_group: isGroup ? 1 : 0,
    unknown_sender_policy: isGroup ? 'request_approval' : 'decline_notify',
    created_at: now(),
  };
  await createMessagingGroup(mg);
  return mg;
}

function mention(mg: MessagingGroup): InboundEvent {
  return {
    channelType: 'slack',
    instance: INSTANCE,
    platformId: mg.platform_id,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk',
      timestamp: now(),
      isMention: true,
      isGroup: mg.is_group === 1,
      content: JSON.stringify({ text: '@Klára ahoj' }),
    },
  };
}

/** Drive the seam exactly as the router's gate does. */
async function escalate(mg: MessagingGroup, senderUserId: string | null): Promise<void> {
  const { requestChannelApproval } = await import('../modules/permissions/channel-approval.js');
  await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg), senderUserId });
}

async function wiringsFor(mgId: string): Promise<MessagingGroupAgent[]> {
  return await getDb().all<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?',
    mgId,
  );
}

describe('slack auto-wire — DM surface (unchanged behaviour)', () => {
  it('raises a card when the DM switch is off', async () => {
    const mg = await unwired('dm-off', false);
    await escalate(mg, 'slack:U_STAFF');

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('wires any sender when the DM switch is on, and replays the message', async () => {
    process.env[DM_KEY] = 'klara';
    const mg = await unwired('dm-on', false);
    await escalate(mg, 'slack:U_STAFF');

    const rows = await wiringsFor(mg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_group_id).toBe('ag-klara');
    // The DM stamp this module has always written — deliberately not the
    // declaration's per-thread shape (that would flip existing installs).
    expect(rows[0].session_mode).toBe('shared');
    expect(rows[0].engage_mode).toBe('pattern');
    expect(deliverMock).not.toHaveBeenCalled();
    expect(routeInboundMock).toHaveBeenCalledTimes(1);
  });

  it('does not borrow the channel target for a DM', async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('dm-channel-key-only', false);
    await escalate(mg, 'slack:U_OWNER');

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});

describe('slack auto-wire — channel surface', () => {
  it('raises a card when the channel switch is off, even for the owner', async () => {
    process.env[DM_KEY] = 'klara'; // DM auto-wire on; channels must stay off
    const mg = await unwired('chan-off', true);
    await escalate(mg, 'slack:U_OWNER');

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("wires on an owner's mention and replays it", async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-owner', true);
    await escalate(mg, 'slack:U_OWNER');

    const rows = await wiringsFor(mg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_group_id).toBe('ag-klara');
    expect(deliverMock).not.toHaveBeenCalled();
    expect(routeInboundMock).toHaveBeenCalledTimes(1);
  });

  it("wires on a scoped admin's mention of the group they administer", async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-admin', true);
    await escalate(mg, 'slack:U_ADMIN');

    expect(await wiringsFor(mg.id)).toHaveLength(1);
  });

  it("does NOT wire on a scoped admin's mention when the target is another agent", async () => {
    process.env[CHANNEL_KEY] = 'marta'; // U_ADMIN is admin of ag-klara only
    const mg = await unwired('chan-wrong-group', true);
    await escalate(mg, 'slack:U_ADMIN');

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT wire on a colleague's mention — it raises the card instead", async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-staff', true);
    await escalate(mg, 'slack:U_STAFF');

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the sender cannot be identified', async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-anon', true);
    await escalate(mg, null);

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("takes Slack's declared GROUP semantics, not the DM stamp", async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-semantics', true);
    await escalate(mg, 'slack:U_OWNER');

    const [row] = await wiringsFor(mg.id);
    // SLACK_DEFAULTS.group — sticky engagement, bounded per thread.
    expect(row.engage_mode).toBe('mention-sticky');
    expect(row.session_mode).toBe('per-thread');
    expect(row.threads).toBe(1);
    expect(row.sender_scope).toBe('all');
    expect(row.ignored_message_policy).toBe('accumulate');
  });

  it('opens the second gate too — an unknown sender may speak in the room', async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-gate', true);
    expect(mg.unknown_sender_policy).toBe('request_approval');

    await escalate(mg, 'slack:U_OWNER');

    expect((await getMessagingGroup(mg.id))!.unknown_sender_policy).toBe('public');
  });

  it('is idempotent on a redelivered mention', async () => {
    process.env[CHANNEL_KEY] = 'klara';
    const mg = await unwired('chan-twice', true);
    await escalate(mg, 'slack:U_OWNER');
    await escalate(mg, 'slack:U_OWNER');

    expect(await wiringsFor(mg.id)).toHaveLength(1);
    // Second pass short-circuits before wiring, so it must not replay again.
    expect(routeInboundMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the card when the switch names no agent group', async () => {
    process.env[CHANNEL_KEY] = 'nobody';
    const mg = await unwired('chan-bad-target', true);
    await escalate(mg, 'slack:U_OWNER');

    expect(await wiringsFor(mg.id)).toHaveLength(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
