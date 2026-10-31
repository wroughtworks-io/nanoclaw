/**
 * Per-person memory — the `principal` namespace (Wroughtworks decision 0026).
 *
 * Each person who DMs an agent has a small private memory on the host:
 *   data/v2-people/<agent_group_id>/<sha256(requester)[:16]>/
 *     items.json  canonical, written only here
 *     PAMET.md    rendered from items.json; what the agent reads
 * mounted read-only at /workspace/osobni into that person's DM sessions only
 * (buildMounts: session.requester_user_id AND the per-agent flag).
 *
 * No silent writes. The agent can only PROPOSE (system action
 * person_memory_propose). The host posts the exact text to the person and
 * stores it only when that person's NEXT message in the DM is a plain yes
 * (isPlainYes). Anything else drops the proposal and the message reaches the
 * agent as usual. The model never judges the reply and cannot store.
 *
 * Forgetting removes at once and is announced by the host.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getDb } from './db/connection.js';
import { getContainerConfig } from './db/container-configs.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { log } from './log.js';
import { writeOutboundDirect } from './session-manager.js';
import type { Session } from './types.js';

export const PERSON_MEMORY_CONTAINER_PATH = '/workspace/osobni';
export const MAX_ITEM_LEN = 500;
export const MAX_ITEMS = 100;
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The whole reply must be one of these, after trimming, lower-casing and
 * stripping trailing punctuation. Narrow on purpose: a false "no" costs one
 * re-ask; a false "yes" stores something the person did not agree to.
 */
const YES_WORDS = new Set(['ano', 'jo', 'jj', 'ok', 'okay', 'yes', '👍']);

export function isPlainYes(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!,]+$/u, '')
    .trim();
  return YES_WORDS.has(t);
}

// ── Store ──

export interface MemoryItem {
  id: number;
  text: string;
  created_at: string;
  /** Provenance (ARCHITECTURE-01 §2 rule 2): where the item came from and who approved it. */
  session_id: string;
  proposal_id: string;
  approval_message_id: string;
}

interface MemoryFile {
  requester_user_id: string;
  next_id: number;
  items: MemoryItem[];
}

function hashRequester(requesterUserId: string): string {
  return crypto.createHash('sha256').update(requesterUserId).digest('hex').slice(0, 16);
}

export function peopleRoot(): string {
  return path.join(DATA_DIR, 'v2-people');
}

export function personDir(agentGroupId: string, requesterUserId: string): string {
  return path.join(peopleRoot(), agentGroupId, hashRequester(requesterUserId));
}

function readFile(dir: string, requesterUserId: string): MemoryFile {
  const file = path.join(dir, 'items.json');
  if (!fs.existsSync(file)) return { requester_user_id: requesterUserId, next_id: 1, items: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MemoryFile;
  if (parsed.requester_user_id !== requesterUserId) {
    // A hash collision or a hand-edited file: refuse rather than mix two people.
    throw new Error(`person memory at ${dir} belongs to a different requester`);
  }
  return parsed;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function renderMemory(mf: MemoryFile): string {
  const head =
    '# Co si o tobě pamatuji\n\n' +
    'Uloženo jen s tvým souhlasem. Vidíš to jen ty, v naší soukromé konverzaci.\n' +
    'Řekni „zapomeň …“ a položku smažu.\n\n';
  if (mf.items.length === 0) return head + '_Zatím nic._\n';
  return head + mf.items.map((i) => `${i.id}. ${i.text}  _(uloženo ${i.created_at.slice(0, 10)})_`).join('\n') + '\n';
}

function save(dir: string, mf: MemoryFile): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, 'items.json'), JSON.stringify(mf, null, 2) + '\n');
  writeAtomic(path.join(dir, 'PAMET.md'), renderMemory(mf));
}

/** Create the person's folder (with an empty PAMET.md) so it can be mounted. Returns the host path. */
export function ensurePersonDir(agentGroupId: string, requesterUserId: string): string {
  const dir = personDir(agentGroupId, requesterUserId);
  if (!fs.existsSync(path.join(dir, 'PAMET.md'))) save(dir, readFile(dir, requesterUserId));
  return dir;
}

export function listItems(agentGroupId: string, requesterUserId: string): MemoryItem[] {
  return readFile(personDir(agentGroupId, requesterUserId), requesterUserId).items;
}

function addItem(
  agentGroupId: string,
  requesterUserId: string,
  item: Omit<MemoryItem, 'id' | 'created_at'>,
): MemoryItem | null {
  const dir = personDir(agentGroupId, requesterUserId);
  const mf = readFile(dir, requesterUserId);
  if (mf.items.length >= MAX_ITEMS) return null;
  const stored: MemoryItem = { id: mf.next_id, created_at: new Date().toISOString(), ...item };
  mf.items.push(stored);
  mf.next_id += 1;
  save(dir, mf);
  return stored;
}

/** Remove the given item ids, or every item. Returns what was removed. */
export function forgetItems(agentGroupId: string, requesterUserId: string, ids: number[] | 'all'): MemoryItem[] {
  const dir = personDir(agentGroupId, requesterUserId);
  const mf = readFile(dir, requesterUserId);
  const removed = ids === 'all' ? mf.items : mf.items.filter((i) => ids.includes(i.id));
  if (removed.length === 0) return [];
  mf.items = mf.items.filter((i) => !removed.includes(i));
  save(dir, mf);
  return removed;
}

/** Operator erasure: delete a person's memory for every agent. Returns how many folders were removed. */
export function erasePerson(requesterUserId: string): number {
  const root = peopleRoot();
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const agentGroupId of fs.readdirSync(root)) {
    const dir = personDir(agentGroupId, requesterUserId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// ── Proposals ──
//
// Consent is bound to the person having SEEN the exact text: a proposal can be
// approved only after its ask was delivered (asked_at, set by the post-delivery
// hook) and only while the ask is still the last thing delivered in the DM — any
// later message to the person voids it ('interrupted'), so an "ano" can never be
// read as approval of something above the latest question. Proposal text is
// cleared once a proposal is settled: the only copy of an item is items.json.

interface ProposalRow {
  id: string;
  session_id: string;
  agent_group_id: string;
  requester_user_id: string;
  text: string;
  status: string;
  created_at: string;
  ask_message_id: string | null;
  asked_at: string | null;
}

async function latestPending(sessionId: string): Promise<ProposalRow | undefined> {
  return getDb().get<ProposalRow>(
    `SELECT * FROM person_memory_proposals WHERE session_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    sessionId,
  );
}

/** Settle a pending proposal. Atomic: returns false if another path settled it first. Clears the text. */
async function settleProposal(id: string, status: string, messageId: string | null): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE person_memory_proposals SET status = ?, text = '', resolved_at = ?, resolved_message_id = ?
       WHERE id = ? AND status = 'pending'`,
    status,
    new Date().toISOString(),
    messageId,
    id,
  );
  return res.changes > 0;
}

/**
 * An agent with any agent-shared wiring can have a channel routed into a DM
 * session (agent-shared resolves to the agent's latest session, whatever its
 * messaging group). Such an agent gets no personal memory at all.
 */
export async function agentHasSharedWiring(agentGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id = ? AND session_mode = 'agent-shared'`,
    agentGroupId,
  );
  return (row?.n ?? 0) > 0;
}

function newOutboundId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Post a host-authored line into the session's DM. */
async function postToPerson(session: Session, text: string, id: string): Promise<void> {
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg) throw new Error(`no messaging group for session ${session.id}`);
  await writeOutboundDirect(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: session.thread_id,
    content: JSON.stringify({ text }),
  });
}

/** The session's DM check, shared by every path that touches a person's memory. */
async function dmAllowed(session: Session): Promise<boolean> {
  if (!session.requester_user_id) return false;
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || mg.is_group !== 0) return false;
  const cfg = await getContainerConfig(session.agent_group_id);
  if (cfg?.person_memory !== 1) return false;
  return !(await agentHasSharedWiring(session.agent_group_id));
}

export type ProposeOutcome =
  | { ok: true; proposalId: string }
  | { ok: false; reason: 'not_a_dm' | 'disabled' | 'empty' | 'too_long' | 'full' };

/**
 * Hold an agent's proposal and ask the person. Refused unless the session has
 * a requester (a DM — see dmRequesterFor), its messaging group is really a DM
 * (checked again here, not trusted), the agent has the flag, and the agent has
 * no agent-shared wiring.
 */
export async function proposeItem(session: Session, rawText: unknown): Promise<ProposeOutcome> {
  const requester = session.requester_user_id;
  if (!requester) return { ok: false, reason: 'not_a_dm' };
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || mg.is_group !== 0) return { ok: false, reason: 'not_a_dm' };
  if (!(await dmAllowed(session))) return { ok: false, reason: 'disabled' };

  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_ITEM_LEN) return { ok: false, reason: 'too_long' };
  if (listItems(session.agent_group_id, requester).length >= MAX_ITEMS) return { ok: false, reason: 'full' };

  // One pending proposal per session: a new one replaces the old.
  await getDb().run(
    `UPDATE person_memory_proposals SET status = 'superseded', text = '', resolved_at = ?
       WHERE session_id = ? AND status = 'pending'`,
    new Date().toISOString(),
    session.id,
  );
  const id = newOutboundId('pmp');
  const askId = newOutboundId('pm-ask');
  await getDb().run(
    `INSERT INTO person_memory_proposals
       (id, session_id, agent_group_id, requester_user_id, text, status, created_at, ask_message_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    session.id,
    session.agent_group_id,
    requester,
    text,
    new Date().toISOString(),
    askId,
  );
  try {
    await postToPerson(
      session,
      `Mám si zapamatovat: „${text}“?\nOdpověz *ano* — jakákoli jiná odpověď návrh zruší.`,
      askId,
    );
  } catch (err) {
    await settleProposal(id, 'failed', null);
    throw err;
  }
  log.info('person-memory: proposal held', { sessionId: session.id, proposalId: id });
  return { ok: true, proposalId: id };
}

/**
 * Post-delivery hook (registered by the module): the ask reaching the person
 * arms its proposal; anything else delivered after an armed ask voids it.
 */
export async function onDelivered(messageId: string, session: Session): Promise<void> {
  const pending = await latestPending(session.id);
  if (!pending) return;
  if (messageId === pending.ask_message_id) {
    await getDb().run(
      `UPDATE person_memory_proposals SET asked_at = ? WHERE id = ? AND status = 'pending' AND asked_at IS NULL`,
      new Date().toISOString(),
      pending.id,
    );
  } else if (pending.asked_at) {
    await settleProposal(pending.id, 'interrupted', null);
    log.info('person-memory: proposal voided by a later message', { sessionId: session.id, proposalId: pending.id });
  }
}

/**
 * Called by the router for every inbound chat message in a session, before
 * the agent sees it. Returns true when the message was the person's yes and
 * has been consumed (stored + confirmed); false lets it route as usual.
 *
 * Only the session's own requester can resolve its proposal, only after its
 * ask was delivered, and only with a message sent after that. Any other reply
 * declines it; a proposal older than PROPOSAL_TTL_MS expires. The yes is
 * consumed so one "ano" can never also answer a question of the agent's.
 */
export async function resolveReply(
  session: Session,
  senderUserId: string | null,
  text: string,
  messageId: string,
  sentAt?: string,
): Promise<boolean> {
  const requester = session.requester_user_id;
  if (!requester || senderUserId !== requester) return false;
  const pending = await latestPending(session.id);
  if (!pending || pending.requester_user_id !== requester) return false;
  // Not yet seen by the person, or this message was written before it arrived: leave it pending.
  if (!pending.asked_at) return false;
  if (sentAt && Date.parse(sentAt) < Date.parse(pending.asked_at)) return false;

  if (Date.now() - Date.parse(pending.created_at) > PROPOSAL_TTL_MS) {
    await settleProposal(pending.id, 'expired', messageId);
    return false;
  }
  if (!isPlainYes(text)) {
    await settleProposal(pending.id, 'declined', messageId);
    log.info('person-memory: proposal declined', { sessionId: session.id, proposalId: pending.id });
    return false;
  }
  if (!(await dmAllowed(session))) {
    await settleProposal(pending.id, 'failed', messageId);
    return false;
  }

  // Claim first: of two quick yeses only one stores.
  if (!(await settleProposal(pending.id, 'approved', messageId))) return true;
  let stored: MemoryItem | null;
  try {
    stored = addItem(session.agent_group_id, requester, {
      text: pending.text,
      session_id: session.id,
      proposal_id: pending.id,
      approval_message_id: messageId,
    });
  } catch (err) {
    await getDb().run(`UPDATE person_memory_proposals SET status = 'failed' WHERE id = ?`, pending.id);
    log.error('person-memory: store failed after approval', { sessionId: session.id, proposalId: pending.id, err });
    await postToPerson(session, 'Uložení se nepodařilo, nic není uloženo.', newOutboundId('pm-fail'));
    return true;
  }
  if (!stored) {
    await getDb().run(`UPDATE person_memory_proposals SET status = 'full' WHERE id = ?`, pending.id);
    await postToPerson(session, 'Paměť je plná, nic se neuložilo. Řekni, co mám zapomenout.', newOutboundId('pm-full'));
    return true;
  }
  await postToPerson(session, `Uloženo (${stored.id}).`, newOutboundId('pm-saved'));
  log.info('person-memory: item stored', { sessionId: session.id, proposalId: pending.id, itemId: stored.id });
  return true;
}

/** Forget items on the agent's request, in the requester's own DM session only. Announced to the person. */
export async function forgetOnRequest(session: Session, ids: number[] | 'all'): Promise<MemoryItem[] | null> {
  const requester = session.requester_user_id;
  if (!requester || !(await dmAllowed(session))) return null;
  const removed = forgetItems(session.agent_group_id, requester, ids);
  if (removed.length > 0) {
    const lines = removed.map((i) => `„${i.text}“`).join('\n');
    await postToPerson(session, `Zapomenuto:\n${lines}`, newOutboundId('pm-forgot'));
  }
  return removed;
}

/** Operator erasure: the person's folders for every agent AND every proposal row. Returns counts. */
export async function eraseRequester(requesterUserId: string): Promise<{ folders: number; proposals: number }> {
  const folders = erasePerson(requesterUserId);
  const res = await getDb().run('DELETE FROM person_memory_proposals WHERE requester_user_id = ?', requesterUserId);
  return { folders, proposals: res.changes };
}
