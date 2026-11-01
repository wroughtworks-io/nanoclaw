/**
 * Instant acknowledgement reaction — default module (opt-in per agent group via
 * container_configs.instant_ack, migration 027).
 *
 * A cold container takes a while to produce its first reply, and the typing
 * indicator is invisible in many Slack views. When a message wakes the agent
 * and no user-facing reply has been delivered after a short delay, the host
 * puts an `eyes` reaction on THAT message; the first delivered reply removes it.
 *
 * Lifecycle of one ack (keyed session + raw platform message id):
 *   waiting --delay--> adding --> eyes --reply delivered--> removed
 *      |                                 --container exit / wake failure--> warned (warning)
 *      |                                 --max age--> removed
 *      +-- reply delivered before the delay: dropped, nothing ever shown
 *   warned --later reply delivered / max age--> removed
 *
 * A session can have several pending acks (messages arriving mid-turn); a
 * delivery resolves all of them. Host-sweep retries do not touch acks: eyes
 * stays up while the wake is retried and is cleaned up by `finish`.
 *
 * Max age (MAX_ACK_AGE_MS, from the wake): the ack is CLEARED, not turned to
 * the warning. Eyes only claims "received, working"; after 30 minutes it no
 * longer informs, but a long legitimate run is not a failure either. The
 * warning is reserved for definitive failure signals (container exit or wake
 * failure with nothing delivered).
 *
 * Persistence: once eyes/warning is on a message a row is written to
 * `pending_acks`; it is deleted when the ack settles. `sweepPersistedAcks`
 * runs at startup: leftover `eyes` rows are removed — or replaced with the
 * warning if older than MAX_ACK_AGE_MS (the host was down for longer than a
 * run is allowed to look alive, so the message may well have been dropped).
 * Leftover `warning` rows are just forgotten (the warning stays).
 *
 * Every reaction call is best-effort: logged, never thrown into routing,
 * delivery or container teardown. `already_reacted` / `no_reaction` count as
 * success.
 *
 * Known limits (accepted):
 *   - Core instructions let the model add eyes itself. It is the same bot
 *     user, so removing ours also removes the model's. Not changed here
 *     (container/ is untouched; template guidance lives in the product repo).
 *   - Two agent groups answering one message through the same bot share one
 *     eyes reaction; the first reply removes it for both.
 *
 * Default module status: ships on trunk, imported directly by core, no
 * registry. Removing requires editing src/router.ts, src/delivery.ts,
 * src/container-runner.ts and src/index.ts.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

export const DEFAULT_ACK_DELAY_MS = 3000;
export const MAX_ACK_AGE_MS = 30 * 60 * 1000;
const EYES = 'eyes';
const WARNING = 'warning';

export interface AckAdapter {
  /** Add (or, with `remove`, delete) a reaction on a user message. Rejects on failure. */
  react?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance: string | undefined,
    messageId: string,
    emoji: string,
    remove?: boolean,
  ): Promise<void>;
  /** False when the resolved channel has no reactions; absent = assume it can. */
  canReact?(channelType: string, instance: string | undefined): boolean;
}

export interface StartAckParams {
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  /** RAW platform message id of the user message (not the namespaced session row id). */
  messageId: string | undefined;
  delayMs?: number | null;
}

type Phase = 'waiting' | 'adding' | 'eyes' | 'warned' | 'done';
type Settle = 'remove' | 'warn';

interface Ack {
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
  messageId: string;
  createdAt: number;
  /** Session delivery sequence when this ack was created; a change means a reply landed first. */
  seqAtStart: number;
  phase: Phase;
  /** Settle requested while a reaction call was in flight. */
  queued?: Settle;
  delayTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
}

interface SessionAcks {
  seq: number;
  acks: Map<string, Ack>;
}

let adapter: AckAdapter | null = null;
const sessions = new Map<string, SessionAcks>();

/** Bind to the channel delivery adapter. Called by `setDeliveryAdapter`. */
export function setAckAdapter(a: AckAdapter): void {
  adapter = a;
}

/** Test seam: forget all in-memory state and timers. */
export function resetAckState(): void {
  for (const s of sessions.values()) {
    for (const ack of s.acks.values()) {
      clearTimeout(ack.delayTimer);
      clearTimeout(ack.expiryTimer);
    }
  }
  sessions.clear();
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & { code?: unknown; data?: { error?: unknown } };
    return `${err.message} ${String(extra.code ?? '')} ${String(extra.data?.error ?? '')}`;
  }
  return String(err);
}

function isBenign(err: unknown, remove: boolean): boolean {
  const text = errorText(err).toLowerCase();
  return remove ? text.includes('no_reaction') : text.includes('already_reacted');
}

/** Best-effort reaction call. True = the reaction is in the wanted state. */
async function react(
  target: Pick<Ack, 'channelType' | 'platformId' | 'threadId' | 'instance' | 'messageId'>,
  emoji: string,
  remove: boolean,
): Promise<boolean> {
  try {
    if (!adapter?.react) throw new Error('reactions unsupported by delivery adapter');
    await adapter.react(
      target.channelType,
      target.platformId,
      target.threadId,
      target.instance,
      target.messageId,
      emoji,
      remove,
    );
    return true;
  } catch (err) {
    if (isBenign(err, remove)) return true;
    log.warn('Ack reaction failed', {
      emoji,
      remove,
      messageId: target.messageId,
      channelType: target.channelType,
      err,
    });
    return false;
  }
}

async function persist(ack: Ack, state: 'eyes' | 'warning'): Promise<void> {
  try {
    await getDb().run(
      `INSERT INTO pending_acks (session_id, message_id, channel_type, platform_id, thread_id, instance, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, message_id) DO UPDATE SET state = excluded.state`,
      ack.sessionId,
      ack.messageId,
      ack.channelType,
      ack.platformId,
      ack.threadId,
      ack.instance ?? null,
      state,
      ack.createdAt,
    );
  } catch (err) {
    log.warn('Ack persist failed', { sessionId: ack.sessionId, messageId: ack.messageId, err });
  }
}

async function unpersist(sessionId: string, messageId: string): Promise<void> {
  try {
    await getDb().run('DELETE FROM pending_acks WHERE session_id = ? AND message_id = ?', sessionId, messageId);
  } catch (err) {
    log.warn('Ack unpersist failed', { sessionId, messageId, err });
  }
}

/** Forget an ack (timers, memory). Does not touch the platform or the table. */
function forget(ack: Ack): void {
  ack.phase = 'done';
  clearTimeout(ack.delayTimer);
  clearTimeout(ack.expiryTimer);
  const s = sessions.get(ack.sessionId);
  if (!s) return;
  s.acks.delete(ack.messageId);
  if (s.acks.size === 0) sessions.delete(ack.sessionId);
}

async function finishRemoved(ack: Ack): Promise<void> {
  forget(ack);
  await unpersist(ack.sessionId, ack.messageId);
}

/** Drive an ack to its end state. Never throws. */
async function settle(ack: Ack, action: Settle): Promise<void> {
  try {
    switch (ack.phase) {
      case 'done':
        return;
      case 'adding':
        // A reaction call is in flight; the add-completion path honors this.
        ack.queued = action === 'remove' || ack.queued === undefined ? action : ack.queued;
        return;
      case 'waiting':
        clearTimeout(ack.delayTimer);
        if (action === 'remove') {
          forget(ack);
          return;
        }
        // Failure before the delay elapsed: show the warning directly.
        ack.phase = 'adding';
        if (await react(ack, WARNING, false)) {
          await persist(ack, 'warning');
          ack.phase = 'warned';
          await afterAdd(ack);
        } else {
          forget(ack);
        }
        return;
      case 'eyes':
        if (action === 'remove') {
          ack.phase = 'adding';
          await react(ack, EYES, true);
          await finishRemoved(ack);
          return;
        }
        ack.phase = 'adding';
        await react(ack, EYES, true);
        if (await react(ack, WARNING, false)) {
          await persist(ack, 'warning');
          ack.phase = 'warned';
          await afterAdd(ack);
        } else {
          await finishRemoved(ack);
        }
        return;
      case 'warned':
        if (action === 'remove') {
          ack.phase = 'adding';
          await react(ack, WARNING, true);
          await finishRemoved(ack);
        }
        return;
    }
  } catch (err) {
    log.warn('Ack settle failed', { sessionId: ack.sessionId, messageId: ack.messageId, err });
    forget(ack);
  }
}

/** Run a settle that was requested while a reaction call was in flight. */
async function afterAdd(ack: Ack): Promise<void> {
  const queued = ack.queued;
  ack.queued = undefined;
  if (queued) await settle(ack, queued);
}

async function fire(ack: Ack): Promise<void> {
  try {
    if (ack.phase !== 'waiting') return;
    const s = sessions.get(ack.sessionId);
    if (!s || s.seq !== ack.seqAtStart) {
      // A user-facing reply was delivered before the delay elapsed.
      forget(ack);
      return;
    }
    ack.phase = 'adding';
    if (!(await react(ack, EYES, false))) {
      forget(ack);
      return;
    }
    await persist(ack, 'eyes');
    ack.phase = 'eyes';
    await afterAdd(ack);
  } catch (err) {
    log.warn('Ack fire failed', { sessionId: ack.sessionId, messageId: ack.messageId, err });
    forget(ack);
  }
}

/**
 * Schedule the ack for a message that woke the agent. No-op without a platform
 * message id. Synchronous and non-throwing.
 */
export function startAck(params: StartAckParams): void {
  try {
    const { sessionId, messageId } = params;
    if (!messageId) return;
    // Channels without reactions (cli, gate traffic) get no ack at all — no 👀, no ⚠️, no warning.
    if (adapter?.canReact && !adapter.canReact(params.channelType, params.instance)) return;
    let s = sessions.get(sessionId);
    if (s?.acks.has(messageId)) return;
    if (!s) {
      s = { seq: 0, acks: new Map() };
      sessions.set(sessionId, s);
    }
    const delay = params.delayMs ?? DEFAULT_ACK_DELAY_MS;
    const ack: Ack = {
      sessionId,
      channelType: params.channelType,
      platformId: params.platformId,
      threadId: params.threadId,
      instance: params.instance,
      messageId,
      createdAt: Date.now(),
      seqAtStart: s.seq,
      phase: 'waiting',
    };
    ack.delayTimer = setTimeout(() => void fire(ack), delay);
    ack.delayTimer.unref();
    ack.expiryTimer = setTimeout(() => void settle(ack, 'remove'), MAX_ACK_AGE_MS);
    ack.expiryTimer.unref();
    s.acks.set(messageId, ack);
  } catch (err) {
    log.warn('startAck failed', { sessionId: params.sessionId, err });
  }
}

/**
 * A user-facing message was delivered for this session: cancel acks that have
 * not fired, remove the eyes (or a lingering warning) from the rest.
 */
export function resolveAck(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.seq++;
  for (const ack of [...s.acks.values()]) void settle(ack, 'remove');
}

/**
 * The container exited, or the wake failed, with nothing delivered: turn the
 * pending acks into the warning.
 */
export function failAck(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  for (const ack of [...s.acks.values()]) void settle(ack, 'warn');
}

interface PendingAckRow {
  session_id: string;
  message_id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  instance: string | null;
  state: string;
  created_at: number;
}

/**
 * Startup: clear reactions the previous host process left behind. Call after
 * the delivery adapter is bound. Best-effort per row; every row is deleted
 * whatever the platform says, so a failing row cannot be retried forever.
 */
export async function sweepPersistedAcks(now: number = Date.now()): Promise<number> {
  let rows: PendingAckRow[];
  try {
    rows = await getDb().all<PendingAckRow>('SELECT * FROM pending_acks');
  } catch (err) {
    log.warn('Ack startup sweep: could not read pending_acks', { err });
    return 0;
  }
  for (const row of rows) {
    const target = {
      channelType: row.channel_type,
      platformId: row.platform_id,
      threadId: row.thread_id,
      instance: row.instance ?? undefined,
      messageId: row.message_id,
    };
    if (row.state === 'eyes') {
      await react(target, EYES, true);
      if (now - row.created_at > MAX_ACK_AGE_MS) await react(target, WARNING, false);
    }
    await unpersist(row.session_id, row.message_id);
  }
  if (rows.length > 0) log.info('Ack startup sweep done', { count: rows.length });
  return rows.length;
}
