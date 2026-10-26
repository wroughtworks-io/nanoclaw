/**
 * Per-session credential for the host-side Notion token broker.
 *
 * The model never chooses whose Notion identity is used: the requester is a
 * host-set column on the session row (`requester_user_id`, DM sessions only),
 * and the container proves which session it is by presenting a secret that
 * the host minted for THIS container start. The broker resolves
 * `sha256(secret)` -> `sessions.requester_user_id`; nothing the agent says
 * enters that lookup.
 */
import crypto from 'crypto';

import { readEnvFile } from './env.js';
import { setSessionBrokerTokenHash } from './db/sessions.js';
import { looksLikeCredential } from './drivers/types.js';
import { log } from './log.js';
import type { ContainerConfig } from './container-config.js';
import type { Session } from './types.js';

export interface BrokerEnv {
  NANOCLAW_BROKER_TOKEN: string;
  NANOCLAW_NOTION_BROKER_URL: string;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 32 random bytes, base64url (43 chars). The spec validator refuses env values
 * that look like an issuer-assigned credential (`sk-…`, `ghp_…`, `xoxb-…`);
 * a random base64url string hits one of those prefixes about once in 260k
 * draws. Re-draw rather than weaken the guard.
 */
export function mintBrokerSecret(): string {
  for (;;) {
    const secret = crypto.randomBytes(32).toString('base64url');
    if (!looksLikeCredential(secret)) return secret;
  }
}

/** Host env first, then .env — same precedence as config.ts. */
export function configuredBrokerUrl(): string | undefined {
  const raw = process.env.NOTION_BROKER_URL || readEnvFile(['NOTION_BROKER_URL']).NOTION_BROKER_URL;
  const url = raw?.trim();
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
  // eslint-disable-next-line no-catch-all/no-catch-all -- an unparseable URL is a config error: disable, don't crash spawn
  } catch {
    log.warn('NOTION_BROKER_URL is not a valid http(s) URL; personal Notion server disabled');
    return undefined;
  }
  return url;
}

/**
 * Mint + persist, only when ALL hold: the session has a requester, the agent
 * opted in (`notionBroker`), and the host has a broker URL. The hash is stored
 * before the container starts and overwrites the previous one, so a prior
 * container's secret stops resolving the moment a new one is minted.
 * Returns the env for the container, or undefined (and clears nothing).
 */
export async function prepareBrokerEnv(
  session: Session,
  containerConfig: ContainerConfig,
  brokerUrl: string | undefined = configuredBrokerUrl(),
): Promise<BrokerEnv | undefined> {
  if (!session.requester_user_id || !containerConfig.notionBroker || !brokerUrl) return undefined;
  const secret = mintBrokerSecret();
  await setSessionBrokerTokenHash(session.id, sha256Hex(secret));
  return { NANOCLAW_BROKER_TOKEN: secret, NANOCLAW_NOTION_BROKER_URL: brokerUrl };
}
