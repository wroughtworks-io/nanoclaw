/**
 * Per-person memory MCP tools (decision 0026): zapamatovat, zapomenout.
 *
 * Registered only when the host mounted the person's memory at
 * /workspace/osobni — which it does in a DM session of an agent that opted in,
 * and nowhere else. Both tools are fire-and-forget system actions: the host
 * asks the person, judges their reply and writes the file. Nothing here can
 * store an item; the mount is read-only.
 */
import fs from 'fs';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MOUNT = '/workspace/osobni';
const MAX_ITEM_LEN = 500;

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const zapamatovat: McpToolDefinition = {
  tool: {
    name: 'zapamatovat',
    description:
      "Propose ONE fact to remember about the person you are talking to in this DM. The host itself asks them, with the exact text, and stores it only if they reply with a plain yes. Do not ask them yourself and do not tell them it is saved — the host does both. Write the text in Czech, as one self-contained sentence about the person (max 500 characters).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The fact to remember, one sentence in Czech' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return err('text is required');
    if (text.length > MAX_ITEM_LEN) return err(`text is longer than ${MAX_ITEM_LEN} characters`);
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'person_memory_propose', text }),
    });
    return ok('Proposal sent. The host is asking the person now; wait for their reply and do not repeat the question.');
  },
};

export const zapomenout: McpToolDefinition = {
  tool: {
    name: 'zapomenout',
    description:
      'Forget items from the memory of the person you are talking to, when THEY ask you to. Item numbers are in /workspace/osobni/PAMET.md. The host removes them at once and tells the person what was forgotten.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, description: 'Item numbers to forget' },
        all: { type: 'boolean', description: 'true to forget everything about this person' },
      },
    },
  },
  async handler(args) {
    const all = args.all === true;
    const ids = Array.isArray(args.ids) ? args.ids.filter((n) => Number.isInteger(n)) : [];
    if (!all && ids.length === 0) return err('give item numbers in ids, or all=true');
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'person_memory_forget', ...(all ? { all: true } : { ids }) }),
    });
    return ok('Forget request sent. The host removes the items and tells the person.');
  },
};

// The host's mount always carries PAMET.md. The host refuses either action anyway when the
// session is not an opted-in DM, so a look-alike folder made inside /workspace gains nothing.
if (fs.existsSync(`${MOUNT}/PAMET.md`)) registerTools([zapamatovat, zapomenout]);
