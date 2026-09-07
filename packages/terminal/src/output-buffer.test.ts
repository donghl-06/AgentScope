import { describe, expect, it } from 'vitest';

import { TerminalOutputBuffer } from './output-buffer.js';

describe('TerminalOutputBuffer', () => {
  it('evicts oldest chunks within byte and chunk bounds', async () => {
    const buffer = new TerminalOutputBuffer({ maxBytes: 5, maxChunks: 2 });

    expect(buffer.push('ab')).toBe(true);
    expect(buffer.push('cd')).toBe(true);
    expect(buffer.push('ef')).toBe(true);
    buffer.close();

    expect(await buffer.next()).toEqual({ done: false, value: 'cd' });
    expect(await buffer.next()).toEqual({ done: false, value: 'ef' });
    expect(await buffer.next()).toEqual({ done: true, value: undefined });
    expect(buffer.stats).toMatchObject({ droppedBytes: 2, droppedChunks: 1 });
  });

  it('drops an oversized chunk instead of splitting it', () => {
    const buffer = new TerminalOutputBuffer({ maxBytes: 4 });

    expect(buffer.push('你好')).toBe(false);
    expect(buffer.stats).toMatchObject({ queuedBytes: 0, droppedChunks: 1 });
  });
});
