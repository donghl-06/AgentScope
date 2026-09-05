import { describe, expect, it } from 'vitest';

import { isIgnoredPath, mergeChangeKinds, normalizeObservedPath } from './index.js';

describe('filesystem observer helpers', () => {
  it('keeps observed paths within the workspace and normalizes separators', () => {
    const root = 'C:/workspace';
    expect(normalizeObservedPath(root, 'src\\app.ts')).toBe('src/app.ts');
    expect(normalizeObservedPath(root, '../secrets.txt')).toBeUndefined();
    expect(normalizeObservedPath(root, 'C:/secrets.txt')).toBeUndefined();
  });

  it('applies default and custom ignore segments', () => {
    expect(isIgnoredPath('node_modules/pkg/index.js')).toBe(true);
    expect(isIgnoredPath('.git/index')).toBe(true);
    expect(isIgnoredPath('src/node_modules-helper.ts')).toBe(false);
    expect(isIgnoredPath('tmp/output.txt', ['tmp'])).toBe(true);
  });

  it('coalesces noisy rename/change events without reading file contents', () => {
    expect(mergeChangeKinds(undefined, 'modify')).toBe('modify');
    expect(mergeChangeKinds('create', 'modify')).toBe('create');
    expect(mergeChangeKinds('modify', 'delete')).toBe('delete');
    expect(mergeChangeKinds('delete', 'create')).toBe('delete');
  });
});
