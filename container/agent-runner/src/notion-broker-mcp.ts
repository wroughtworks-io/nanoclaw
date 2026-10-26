/**
 * Personal Notion MCP server, served by the host-side token broker.
 *
 * The host decides whether and for whom (it mints NANOCLAW_BROKER_TOKEN only
 * for a DM session with a requester, on an opted-in agent). The runner adds
 * the server only when BOTH env vars are present; the Bearer secret is the
 * session's identity to the broker, so the model has no input into whose
 * Notion account answers.
 */
import type { McpServerConfig } from './providers/types.js';

export const NOTION_BROKER_SERVER_NAME = 'notion-osobni';

/** Add `host` to a comma-separated NO_PROXY list unless already listed. */
function withNoProxyHost(existing: string | undefined, host: string): string {
  const entries = (existing ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (!entries.includes(host)) entries.push(host);
  return entries.join(',');
}

/**
 * Returns whether the server was added. Mutates `mcpServers` and `providerEnv`
 * (the env handed to the provider/SDK), adding the broker host to both
 * NO_PROXY and no_proxy so the request bypasses the OneCLI HTTPS proxy.
 * An existing server of the same name is replaced: the broker entry is
 * host-authoritative.
 */
export function addNotionBrokerServer(
  mcpServers: Record<string, McpServerConfig>,
  providerEnv: Record<string, string | undefined>,
  sourceEnv: Record<string, string | undefined> = process.env,
): boolean {
  const token = sourceEnv.NANOCLAW_BROKER_TOKEN;
  const url = sourceEnv.NANOCLAW_NOTION_BROKER_URL;
  if (!token || !url) return false;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  mcpServers[NOTION_BROKER_SERVER_NAME] = {
    type: 'http',
    url,
    headers: { Authorization: `Bearer ${token}` },
  };
  providerEnv.NO_PROXY = withNoProxyHost(providerEnv.NO_PROXY, host);
  providerEnv.no_proxy = withNoProxyHost(providerEnv.no_proxy, host);
  return true;
}
