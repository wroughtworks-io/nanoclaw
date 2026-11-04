/**
 * The one naming rule for DM messaging groups: "DM <person>".
 *
 * A messaging group's name is what agents see for that conversation (the
 * destination display name) and the seed of its destination address
 * (normalizeName → "dm-tereza-bartonova"). Auto-created DMs used to stay
 * unnamed, so agents saw only opaque "slack-mg-…" addresses for every person
 * while channels carried real names. Shared by inbound auto-create, the
 * cold-DM path, and the backfill script so the three cannot drift.
 */
import { senderFromRawContent } from './sender-identity.js';

export function dmName(personName: string | null | undefined): string | null {
  const name = personName?.trim();
  return name ? `DM ${name}` : null;
}

/** DM name from a serialized inbound message's sender; null when it carries no name. */
export function dmNameFromInbound(rawContent: string, channelType: string | null): string | null {
  return dmName(senderFromRawContent(rawContent, channelType)?.displayName);
}
