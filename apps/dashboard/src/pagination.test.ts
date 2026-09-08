import { describe, expect, it } from 'vitest';

import { loadAllPages } from './pagination.js';

describe('loadAllPages', () => {
  it('merges pages in cursor order', async () => {
    const cursors: Array<string | undefined> = [];
    await expect(
      loadAllPages(async (cursor) => {
        cursors.push(cursor);
        if (cursor === undefined) return { items: [1, 2], nextCursor: 'page-2' };
        return { items: [3] };
      }),
    ).resolves.toEqual([1, 2, 3]);
    expect(cursors).toEqual([undefined, 'page-2']);
  });

  it('stops a broken cursor loop at the safe page limit', async () => {
    await expect(loadAllPages(async () => ({ items: [], nextCursor: 'same' }))).rejects.toThrow(
      'safe page limit',
    );
  });
});
