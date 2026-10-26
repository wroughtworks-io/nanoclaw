/**
 * Per-session Claude state — the host path and the container-side constants.
 *
 * Lives beside the session dir (`data/v2-sessions/<ag>/.claude-state/<sess>`),
 * deliberately NOT inside `data/v2-sessions/<ag>/<sess>`, because that dir is
 * mounted RW at /workspace and the state must not be reachable through it.
 */
import path from 'path';

import { DATA_DIR } from './config.js';

export const CLAUDE_STATE_DIRNAME = '.claude-state';

/** Where the runner archives conversations: inside the session's own state. */
export const SESSION_CONVERSATIONS_DIR = '/home/node/.claude/conversations';

export function sessionClaudeStateDir(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, CLAUDE_STATE_DIRNAME, sessionId);
}
