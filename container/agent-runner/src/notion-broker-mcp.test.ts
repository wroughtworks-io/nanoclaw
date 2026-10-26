import { describe, expect, it } from 'bun:test';

import type { McpServerConfig } from './providers/types.js';
import { addNotionBrokerServer } from './notion-broker-mcp.js';

const URL_ = 'http://172.17.0.1:8790/mcp';

describe('addNotionBrokerServer', () => {
  it('adds notion-osobni with a Bearer header when both env vars are present', () => {
    const servers: Record<string, McpServerConfig> = {};
    const env: Record<string, string | undefined> = {};
    expect(
      addNotionBrokerServer(servers, env, { NANOCLAW_BROKER_TOKEN: 'sekret', NANOCLAW_NOTION_BROKER_URL: URL_ }),
    ).toBe(true);
    expect(servers['notion-osobni']).toEqual({ type: 'http', url: URL_, headers: { Authorization: 'Bearer sekret' } });
  });

  it('adds nothing unless BOTH env vars are present', () => {
    for (const src of [{}, { NANOCLAW_BROKER_TOKEN: 'sekret' }, { NANOCLAW_NOTION_BROKER_URL: URL_ }]) {
      const servers: Record<string, McpServerConfig> = {};
      const env: Record<string, string | undefined> = {};
      expect(addNotionBrokerServer(servers, env, src)).toBe(false);
      expect(servers).toEqual({});
      expect(env.NO_PROXY).toBeUndefined();
    }
  });

  it('adds the broker host to NO_PROXY and no_proxy, preserving existing entries, without duplicating', () => {
    const servers: Record<string, McpServerConfig> = {};
    const env: Record<string, string | undefined> = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '172.17.0.1' };
    addNotionBrokerServer(servers, env, { NANOCLAW_BROKER_TOKEN: 't', NANOCLAW_NOTION_BROKER_URL: URL_ });
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost,172.17.0.1');
    expect(env.no_proxy).toBe('172.17.0.1');
  });

  it('replaces a pre-existing server of the same name (host-authoritative)', () => {
    const servers: Record<string, McpServerConfig> = { 'notion-osobni': { type: 'http', url: 'http://evil/mcp' } };
    addNotionBrokerServer(servers, {}, { NANOCLAW_BROKER_TOKEN: 't', NANOCLAW_NOTION_BROKER_URL: URL_ });
    expect((servers['notion-osobni'] as { url: string }).url).toBe(URL_);
  });

  it('ignores an unparseable URL', () => {
    const servers: Record<string, McpServerConfig> = {};
    expect(addNotionBrokerServer(servers, {}, { NANOCLAW_BROKER_TOKEN: 't', NANOCLAW_NOTION_BROKER_URL: 'nope' })).toBe(
      false,
    );
    expect(servers).toEqual({});
  });
});
