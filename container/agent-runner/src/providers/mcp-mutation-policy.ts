/**
 * Third-party MCP mutations are denied by DEFAULT.
 *
 * A connector's MCP server typically ships reads and writes side by side — RAYNET's exposes
 * `businessCase_create` and `company_update` next to its analyses — and the host grants tools
 * per SERVER, as `mcp__<server>__*`. So wiring a server hands the agent its write surface too.
 *
 * That surface cannot be policed downstream: over MCP every call is one POST to one endpoint,
 * so an egress proxy sees a read and a write as the same request. Denial has to happen here,
 * where the tool still has a name.
 *
 * The rule is deliberately narrow: it matches the `_create` / `_update` / `_delete` convention
 * on NON-builtin servers, so the host's own tools (`mcp__nanoclaw__send_message` and friends)
 * are untouched. It is a default, not a law — an agent that should genuinely write will need an
 * explicit allowance, and that allowance should be a decision someone made rather than a
 * capability that arrived with a connector.
 */
export const THIRD_PARTY_MCP_MUTATION = /^mcp__(?!nanoclaw__)[A-Za-z0-9-]+__.*_(create|update|delete)$/;
