/**
 * Notion broker credential: minted only when a DM requester, an opted-in
 * agent and a host broker URL all hold; the stored hash is the sha256 of the
 * env secret; the secret rides the contributed env lane and passes the
 * unmodified spec validator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { configFromDb } from './container-config.js';
import { composeSessionSpec } from './container-runner.js';
import { closeDb, createAgentGroup, createSession, getSession, initSqliteTestDb, runMigrations } from './db/index.js';
import { fixtureSpec, FIXTURE_POLICY } from './drivers/spec-fixture.js';
import { looksLikeCredential, validateSpec } from './drivers/types.js';
import { mintBrokerSecret, prepareBrokerEnv, sha256Hex } from './notion-broker.js';
import type { AgentGroup, Session } from './types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const URL_ = 'http://172.17.0.1:8790/mcp';

const config = (notionBroker?: boolean): ContainerConfig =>
  ({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
    ...(notionBroker === undefined ? {} : { notionBroker }),
  }) as unknown as ContainerConfig;

async function seedSession(requester: string | null): Promise<Session> {
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now });
  const session: Session = {
    id: 's-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now,
    requester_user_id: requester,
  };
  await createSession(session);
  return session;
}

beforeEach(async () => {
  await runMigrations(await initSqliteTestDb());
});
afterEach(async () => {
  await closeDb();
});

describe('prepareBrokerEnv', () => {
  it('mints when requester + notionBroker + URL all hold, and stores sha256(secret)', async () => {
    const session = await seedSession('slack:U1');
    const env = await prepareBrokerEnv(session, config(true), URL_);
    expect(env).toBeDefined();
    expect(env!.NANOCLAW_NOTION_BROKER_URL).toBe(URL_);
    expect(env!.NANOCLAW_BROKER_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = (await getSession('s-1'))!.broker_token_hash!;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(sha256Hex(env!.NANOCLAW_BROKER_TOKEN));
  });

  it('overwrites the previous hash on every start (old secret stops resolving)', async () => {
    const session = await seedSession('slack:U1');
    const first = (await prepareBrokerEnv(session, config(true), URL_))!;
    const second = (await prepareBrokerEnv(session, config(true), URL_))!;
    expect(second.NANOCLAW_BROKER_TOKEN).not.toBe(first.NANOCLAW_BROKER_TOKEN);
    expect((await getSession('s-1'))!.broker_token_hash).toBe(sha256Hex(second.NANOCLAW_BROKER_TOKEN));
  });

  it.each([
    ['no requester', null, true, URL_],
    ['agent not opted in (false)', 'slack:U1', false, URL_],
    ['agent not opted in (absent)', 'slack:U1', undefined, URL_],
    ['no NOTION_BROKER_URL', 'slack:U1', true, undefined],
  ])('mints nothing and stores no hash: %s', async (_name, requester, optIn, url) => {
    const session = await seedSession(requester);
    expect(await prepareBrokerEnv(session, config(optIn), url)).toBeUndefined();
    expect((await getSession('s-1'))!.broker_token_hash).toBeNull();
  });
});

describe('mintBrokerSecret', () => {
  it('never returns a value the spec validator would take for a credential', () => {
    for (let i = 0; i < 2000; i++) expect(looksLikeCredential(mintBrokerSecret())).toBe(false);
  });

  it('re-draws when a draw looks like an issuer credential', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('crypto')>('crypto');
    // 32 bytes whose base64url form is `sk-AAAA…` — what the validator refuses.
    const skBytes = Buffer.from('sk-' + 'A'.repeat(40), 'base64url');
    let calls = 0;
    vi.doMock('crypto', () => ({
      ...real,
      default: {
        ...real,
        randomBytes: (n: number) => {
          calls++;
          return calls === 1 ? Buffer.from(skBytes) : real.randomBytes(n);
        },
      },
    }));
    const mod = await import('./notion-broker.js');
    const secret = mod.mintBrokerSecret();
    expect(calls).toBeGreaterThan(1);
    expect(looksLikeCredential(secret)).toBe(false);
    vi.doUnmock('crypto');
  });
});

describe('composeSessionSpec broker env', () => {
  it('rides the contributed lane (not env) and passes validateSpec unmodified', () => {
    const agentGroup = { id: 'ag-1', name: 'A', folder: 'a' } as AgentGroup;
    const session = { id: 's-1', agent_group_id: 'ag-1' } as Session;
    const secret = mintBrokerSecret();
    const composed = composeSessionSpec({
      agentGroup,
      session,
      containerName: 'nanoclaw-v2-a-1',
      mounts: [],
      containerConfig: config(true),
      mailboxEnvironment: {},
      contribution: {} as never,
      gateway: { env: { NANOCLAW_BROKER_TOKEN: 'from-gateway' } } as never,
      brokerEnv: { NANOCLAW_BROKER_TOKEN: secret, NANOCLAW_NOTION_BROKER_URL: URL_ },
    });
    const agent = composed.containers[0];
    expect(agent.env.NANOCLAW_BROKER_TOKEN).toBeUndefined();
    // Broker env is applied last: a gateway contribution cannot substitute it.
    expect(agent.contributedEnv).toMatchObject({
      NANOCLAW_BROKER_TOKEN: secret,
      NANOCLAW_NOTION_BROKER_URL: URL_,
    });

    const spec = fixtureSpec();
    spec.containers[0] = { ...spec.containers[0], env: agent.env, contributedEnv: agent.contributedEnv };
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
  });

  it('the plain env lane would be refused (documents why the contributed lane is used)', () => {
    const spec = fixtureSpec();
    spec.containers[0] = { ...spec.containers[0], env: { NANOCLAW_BROKER_TOKEN: mintBrokerSecret() } };
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/secret-shaped/);
  });

  it('adds no broker env when none was prepared', () => {
    const composed = composeSessionSpec({
      agentGroup: { id: 'ag-1', name: 'A', folder: 'a' } as AgentGroup,
      session: { id: 's-1', agent_group_id: 'ag-1' } as Session,
      containerName: 'nanoclaw-v2-a-1',
      mounts: [],
      containerConfig: config(true),
      mailboxEnvironment: {},
      contribution: {} as never,
      gateway: {} as never,
    });
    expect(composed.containers[0].contributedEnv).not.toHaveProperty('NANOCLAW_BROKER_TOKEN');
  });
});

describe('configFromDb notionBroker', () => {
  const row = (notion_broker?: number) =>
    ({
      agent_group_id: 'ag-1',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      skills: '[]',
      ...(notion_broker === undefined ? {} : { notion_broker }),
    }) as never;
  const group = { id: 'ag-1', name: 'A', folder: 'a' } as AgentGroup;

  it('is true only when the column is 1', () => {
    expect(configFromDb(row(1), group).notionBroker).toBe(true);
    expect(configFromDb(row(0), group).notionBroker).toBeUndefined();
    expect(configFromDb(row(), group).notionBroker).toBeUndefined();
  });
});
