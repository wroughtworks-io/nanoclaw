/**
 * The default-deny for third-party MCP writes. A regex nobody tests is a regex that will one
 * day match nothing and fail open — and this one is the only thing standing between an agent
 * and a write when the transport hides the verb.
 */
import { describe, expect, it } from 'bun:test';

import { THIRD_PARTY_MCP_MUTATION } from './mcp-mutation-policy.js';

describe('THIRD_PARTY_MCP_MUTATION', () => {
  it('denies connector writes', () => {
    for (const tool of [
      'mcp__raynet__businessCase_create',
      'mcp__raynet__company_update',
      'mcp__raynet__event_delete',
      'mcp__notion__page_update',
    ]) {
      expect(THIRD_PARTY_MCP_MUTATION.test(tool), tool).toBe(true);
    }
  });

  it('leaves connector reads alone', () => {
    for (const tool of [
      'mcp__raynet__businessCase_list',
      'mcp__raynet__businessCase_get',
      'mcp__raynet__company_abcAnalysis',
      'mcp__raynet__activity_completedActivityAnalysis',
    ]) {
      expect(THIRD_PARTY_MCP_MUTATION.test(tool), tool).toBe(false);
    }
  });

  it("never touches the host's own tools", () => {
    // send_message is how an agent answers at all; matching it would mute the fleet.
    for (const tool of [
      'mcp__nanoclaw__send_message',
      'mcp__nanoclaw__create_agent',
      'mcp__nanoclaw__add_mcp_server',
      'Bash',
      'Read',
    ]) {
      expect(THIRD_PARTY_MCP_MUTATION.test(tool), tool).toBe(false);
    }
  });
});
