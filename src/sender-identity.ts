/**
 * Sender identity from a serialized inbound message.
 *
 * The single parser for "who sent this": chat-sdk-bridge serializes author
 * info as a nested `author.userId` and does NOT populate top-level
 * `senderId`; older adapters (v1, native) put `senderId` or `sender` at the
 * top level. Shared by the permissions module (inbound) and the delivery
 * reply-routing guard (outbound) so the extraction cannot drift.
 */
export interface SenderIdentity {
  /** Namespaced user id, e.g. "slack:U0ABC". */
  userId: string;
  displayName: string | undefined;
}

export function senderFromContent(content: Record<string, unknown>, channelType: string | null): SenderIdentity | null {
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const displayName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;
  if (!rawHandle.includes(':') && !channelType) return null;
  const userId = rawHandle.includes(':') ? rawHandle : `${channelType}:${rawHandle}`;
  return { userId, displayName };
}

/** Same as senderFromContent, from the raw JSON string; null on unparseable content. */
export function senderFromRawContent(raw: string, channelType: string | null): SenderIdentity | null {
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof content !== 'object' || content === null) return null;
  return senderFromContent(content as Record<string, unknown>, channelType);
}
