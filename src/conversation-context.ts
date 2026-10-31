/**
 * Conversation context on mention — host half.
 *
 * When an agent group has opted in (container_configs.slack_context_fetch)
 * and a MENTION wakes it in a channel/thread, ask the channel adapter for the
 * surrounding history, trim it to a budget, and write it as ONE trigger=0
 * "background" row immediately before the waking message. One row, not N:
 * the container caps a prompt at max_messages_per_prompt rows, so a 50-row
 * context would crowd out the very messages it is meant to explain.
 *
 * Everything here fails soft: any error, timeout or empty result leaves the
 * delivery exactly as it was without the feature. Never throws.
 *
 * Dedupe: "already seen" means ACTUALLY DELIVERED to the agent in an earlier
 * turn (rows completed/processing, plus contextIds of earlier context rows),
 * matched by platform message id. Pending accumulated rows have not reached
 * the agent: the context block covers them, and once the block row is durable
 * those pending rows are retired host-side (status 'completed', conditional on
 * still-pending trigger=0) so they are not delivered twice and do not consume
 * the container's per-prompt row cap. The container's poll only reads
 * status='pending', so no container change is needed. A failed fetch marks
 * nothing and leaves exactly the pre-feature behaviour.
 */
import type {
  ChannelAdapter,
  ConversationContext,
  ConversationContextMessage,
  ConversationContextRequest,
} from './channels/adapter.js';
import { log } from './log.js';
import { TIMEZONE } from './config.js';
import { withExistingMailboxSession, writeSessionMessage } from './session-manager.js';
import { formatLocalStamp } from './timezone.js';

export const CONTEXT_MAX_MESSAGES = 50;
export const CONTEXT_MAX_TOKENS = 8000;
/** Per-message cap so one giant paste cannot consume the whole budget. */
export const CONTEXT_MAX_MESSAGE_CHARS = 2000;
export const CONTEXT_FETCH_TIMEOUT_MS = 3000;
/** How far back into the session's mailbox to look for already-delivered ids. */
const DEDUPE_HISTORY_ROWS = 300;

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function omittedMarker(n: number): string {
  return `(${n} starších zpráv vynecháno)`;
}

function truncate(text: string): string {
  return text.length > CONTEXT_MAX_MESSAGE_CHARS ? `${text.slice(0, CONTEXT_MAX_MESSAGE_CHARS)}…` : text;
}

function formatLine(m: ConversationContextMessage): string {
  const who = m.isSelf ? `you (${m.sender})` : m.sender;
  const when = formatLocalStamp(new Date(m.timestamp), TIMEZONE);
  return `[${when}] ${who}: ${truncate(m.text.replace(/\r?\n/g, '\n  '))}`;
}

export interface BudgetOptions {
  maxMessages?: number;
  maxTokens?: number;
}

/**
 * Trim chronological messages to the budget. For a thread the ROOT is always
 * kept (it frames everything) and the budget is spent on the NEWEST replies;
 * for channel history just the newest. Returns the rendered lines, with the
 * omitted-marker where messages were dropped (after the root / at the start).
 */
export function selectWithinBudget(
  messages: ConversationContextMessage[],
  source: 'thread' | 'channel',
  opts: BudgetOptions = {},
): { lines: string[]; omitted: number; kept: ConversationContextMessage[] } {
  const maxMessages = opts.maxMessages ?? CONTEXT_MAX_MESSAGES;
  const maxTokens = opts.maxTokens ?? CONTEXT_MAX_TOKENS;
  if (messages.length === 0) return { lines: [], omitted: 0, kept: [] };

  const rendered = messages.map(formatLine);
  const keepRoot = source === 'thread';
  const head = keepRoot ? [rendered[0]] : [];
  const rest = keepRoot ? rendered.slice(1) : rendered;
  const restMessages = keepRoot ? messages.slice(1) : messages;

  // Reserve room for the root and a worst-case marker, then take newest-first.
  let tokens = head.reduce((n, l) => n + estimateTokens(l), 0) + estimateTokens(omittedMarker(99999));
  const tail: string[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    if (head.length + tail.length >= maxMessages) break;
    const t = estimateTokens(rest[i]);
    if (tokens + t > maxTokens) break;
    tokens += t;
    tail.unshift(rest[i]);
  }
  const omitted = rest.length - tail.length;
  const lines = omitted > 0 ? [...head, omittedMarker(omitted), ...tail] : [...head, ...tail];
  const kept = [...(keepRoot ? [messages[0]] : []), ...restMessages.slice(rest.length - tail.length)];
  return { lines, omitted, kept };
}

export function renderContextBlock(
  source: 'thread' | 'channel',
  messages: ConversationContextMessage[],
  opts?: BudgetOptions,
): { text: string; kept: ConversationContextMessage[] } | null {
  const { lines, kept } = selectWithinBudget(messages, source, opts);
  if (lines.length === 0) return null;
  const where = source === 'thread' ? 'this Slack thread' : 'this Slack channel (recent messages)';
  const text = [
    `<slack_context source="${source}">`,
    `Background only: earlier messages from ${where}, oldest first, for reference. Do not answer them — answer only the latest message addressed to you, which follows this block.`,
    ...lines,
    '</slack_context>',
  ].join('\n');
  return { text, kept };
}

interface MailboxIdState {
  /** Platform message ids the agent has (or will, unconditionally) receive without our help. */
  seen: Set<string>;
  /** Pending accumulated rows the context block may absorb: platform message id -> mailbox row ids. */
  coverable: Map<string, string[]>;
}

/** Row channel types that carry copies of other sessions' traffic, not this thread's own messages. */
const NON_OWN_CHANNEL_TYPES = new Set(['session-echo', 'agent']);

/**
 * Classify this session's inbound rows by what the agent has actually been given.
 *
 * "Seen" = delivered in an earlier turn: status completed/processing (the container claimed it),
 * plus the contextIds of earlier context rows that were delivered or are queued to be. A PENDING
 * trigger=0 accumulated row has NOT reached the agent and is not seen — it is "coverable" instead
 * (the context block absorbs it and the row is retired afterwards). Pending rows we must not
 * absorb (waking rows, echo/agent copies, earlier context rows) will be delivered on their own,
 * so their ids count as seen to avoid duplicating them. failed/cancelled rows were never
 * delivered and are not seen.
 */
async function classifyMailboxIds(agentGroupId: string, sessionId: string): Promise<MailboxIdState> {
  const seen = new Set<string>();
  const coverable = new Map<string, string[]>();
  const rows = await withExistingMailboxSession(agentGroupId, sessionId, (mb) =>
    mb.getInboundDeliveryState(DEDUPE_HISTORY_ROWS),
  );
  for (const row of rows ?? []) {
    if (row.status === 'failed' || row.status === 'cancelled') continue;
    let c: { id?: unknown; contextIds?: unknown };
    try {
      c = JSON.parse(row.content) as { id?: unknown; contextIds?: unknown };
    } catch {
      continue; // non-JSON content (system rows) carries no platform id
    }
    if (c === null || typeof c !== 'object') continue;
    const isContextRow = Array.isArray(c.contextIds);
    // A previous context block's messages count as delivered (or queued for delivery) too.
    if (isContextRow) for (const id of c.contextIds as unknown[]) if (typeof id === 'string') seen.add(id);
    if (typeof c.id !== 'string' || !c.id) continue;
    const absorbable =
      row.status === 'pending' &&
      !row.trigger &&
      !isContextRow &&
      (row.kind === 'chat' || row.kind === 'chat-sdk') &&
      !NON_OWN_CHANNEL_TYPES.has(row.channelType ?? '');
    if (absorbable) {
      const list = coverable.get(c.id) ?? [];
      list.push(row.id);
      coverable.set(c.id, list);
    } else {
      seen.add(c.id);
    }
  }
  return { seen, coverable };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  // The loser keeps running in the background; swallow its late rejection.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface InjectContextParams {
  adapter: ChannelAdapter | undefined;
  agentGroupId: string;
  sessionId: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  /** ISO timestamp of the waking message; the context row is stamped just before it. */
  messageTimestamp: string;
  channelType: string;
  budget?: BudgetOptions;
  timeoutMs?: number;
}

/**
 * Fetch, dedupe, trim and write the background row. Call BEFORE the waking
 * message is written (so it gets a lower seq and renders first). Returns true
 * when a row was written. Never throws.
 */
export async function injectConversationContext(p: InjectContextParams): Promise<boolean> {
  try {
    const where = { sessionId: p.sessionId, platformId: p.platformId, threadId: p.threadId };
    if (!p.adapter?.fetchConversationContext) {
      log.info('Conversation context skipped: channel adapter has no fetchConversationContext', {
        ...where,
        adapter: p.adapter ? (p.adapter.instance ?? p.adapter.channelType) : 'none registered',
      });
      return false;
    }
    const req: ConversationContextRequest = {
      platformId: p.platformId,
      threadId: p.threadId,
      messageId: p.messageId,
    };
    let ctx: ConversationContext;
    try {
      ctx = await withTimeout(p.adapter.fetchConversationContext(req), p.timeoutMs ?? CONTEXT_FETCH_TIMEOUT_MS);
    } catch (err) {
      // Nothing has been marked at this point: behaviour is exactly the pre-feature path.
      log.warn('Conversation context fetch failed — continuing without it', {
        ...where,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const { seen, coverable } = await classifyMailboxIds(p.agentGroupId, p.sessionId);
    const fresh = ctx.messages.filter((m) => m.id !== p.messageId && !seen.has(m.id));
    if (fresh.length === 0) {
      log.info('Conversation context skipped: nothing new to add (every fetched message was already delivered)', {
        ...where,
        source: ctx.source,
        fetched: ctx.messages.length,
      });
      return false;
    }
    const rendered = renderContextBlock(ctx.source, fresh, p.budget);
    if (!rendered) {
      log.info('Conversation context skipped: rendered block was empty', {
        ...where,
        source: ctx.source,
        fetched: ctx.messages.length,
        fresh: fresh.length,
      });
      return false;
    }

    const ts = new Date(Date.parse(p.messageTimestamp) - 1);
    await writeSessionMessage(p.agentGroupId, p.sessionId, {
      id: `${p.messageId}:slack-context:${p.agentGroupId}`,
      kind: 'chat',
      timestamp: (Number.isNaN(ts.getTime()) ? new Date() : ts).toISOString(),
      platformId: p.platformId,
      channelType: p.channelType,
      threadId: p.threadId,
      content: JSON.stringify({
        text: rendered.text,
        sender: 'Slack history',
        contextIds: rendered.kept.map((m) => m.id),
      }),
      trigger: false,
    });

    // Retire the pending accumulated rows the block now carries, so they are not delivered a second
    // time (and do not eat the container's per-prompt row cap). Strictly AFTER the context row is
    // durable: a crash in between duplicates, never loses. Best-effort: a failure here leaves
    // today's behaviour (duplicates), never an error.
    const coveredRowIds = rendered.kept.flatMap((m) => coverable.get(m.id) ?? []);
    let covered = 0;
    if (coveredRowIds.length > 0) {
      try {
        covered =
          (await withExistingMailboxSession(p.agentGroupId, p.sessionId, (mb) =>
            mb.markPendingContextHandled(coveredRowIds),
          )) ?? 0;
      } catch (err) {
        log.warn('Conversation context: could not retire covered pending rows — they will also be delivered', {
          ...where,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info('Conversation context injected', {
      ...where,
      source: ctx.source,
      fetched: ctx.messages.length,
      fresh: fresh.length,
      kept: rendered.kept.length,
      omitted: fresh.length - rendered.kept.length,
      pendingRowsCovered: covered,
    });
    return true;
  } catch (err) {
    log.warn('Conversation context injection failed — continuing without it', { err });
    return false;
  }
}
