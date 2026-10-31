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
 * Dedupe: messages already present in this session's mailbox (accumulated
 * context rows, or earlier turns), matched by platform message id, are
 * DROPPED FROM THE FETCHED SET rather than replacing the stored rows. Those
 * rows are already being delivered; deleting them would mean mutating the
 * session mailbox on a best-effort path, and a failed fetch would then lose
 * context the old behaviour kept. Dropping is non-destructive and makes the
 * feature strictly additive: the agent sees stored rows + the missing rest.
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

/** Platform message ids already present in the session's mailbox (any status). */
async function deliveredIds(agentGroupId: string, sessionId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const history = await withExistingMailboxSession(agentGroupId, sessionId, (mb) =>
    mb.getInboundHistory(DEDUPE_HISTORY_ROWS),
  );
  for (const row of history ?? []) {
    try {
      const c = JSON.parse(row.content) as { id?: unknown; contextIds?: unknown };
      if (typeof c.id === 'string' && c.id) ids.add(c.id);
      // A previous context block's messages count as delivered too (re-mention in the same thread).
      if (Array.isArray(c.contextIds)) for (const id of c.contextIds) if (typeof id === 'string') ids.add(id);
    } catch {
      // non-JSON content (system rows) carries no platform id
    }
  }
  return ids;
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
    if (!p.adapter?.fetchConversationContext) return false;
    const req: ConversationContextRequest = {
      platformId: p.platformId,
      threadId: p.threadId,
      messageId: p.messageId,
    };
    let ctx: ConversationContext;
    try {
      ctx = await withTimeout(p.adapter.fetchConversationContext(req), p.timeoutMs ?? CONTEXT_FETCH_TIMEOUT_MS);
    } catch (err) {
      log.warn('Conversation context fetch failed — continuing without it', {
        platformId: p.platformId,
        threadId: p.threadId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const seen = await deliveredIds(p.agentGroupId, p.sessionId);
    const fresh = ctx.messages.filter((m) => m.id !== p.messageId && !seen.has(m.id));
    const rendered = renderContextBlock(ctx.source, fresh, p.budget);
    if (!rendered) return false;

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
    log.info('Conversation context injected', {
      sessionId: p.sessionId,
      source: ctx.source,
      fetched: ctx.messages.length,
      deduped: ctx.messages.length - fresh.length,
    });
    return true;
  } catch (err) {
    log.warn('Conversation context injection failed — continuing without it', { err });
    return false;
  }
}
