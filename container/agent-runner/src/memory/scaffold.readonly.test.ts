import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureMemoryScaffold } from './scaffold.js';

describe('ensureMemoryScaffold on a read-only memory dir', () => {
  it('does not throw and writes nothing', () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-ro-'));
    const mem = path.join(base, 'memory');
    fs.mkdirSync(mem);
    fs.chmodSync(mem, 0o555);
    try {
      expect(() => ensureMemoryScaffold(base)).not.toThrow();
      expect(() => ensureMemoryScaffold(base)).not.toThrow();
      expect(fs.readdirSync(mem)).toEqual([]);
    } finally {
      fs.chmodSync(mem, 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
