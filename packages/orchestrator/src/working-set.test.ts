import { describe, expect, it } from 'vitest';

import { maintainWorkingSet, WORKING_SET_MAX_FILES, WORKING_SET_MAX_PATH_BUDGET } from './index.js';

describe('bounded Working Set', () => {
  it('keeps changed and failure files ahead of ordinary candidates', () => {
    const current = {
      files: Array.from({ length: WORKING_SET_MAX_FILES }, (_, index) => `src/old-${index}.ts`),
      directories: ['src'],
      rationale: 'existing context',
      updatedAt: 1,
      appliedInstructions: [
        { id: 'instruction-1', kind: 'constraint', content: 'Keep it safe.', appliedRevision: 1 },
      ],
    } as const;
    const result = maintainWorkingSet({
      current,
      candidates: ['src/new-feature.ts', '.env', 'secrets/api-key.txt'],
      changedFiles: ['src/new-feature.ts'],
      failureFiles: ['src/old-2.ts'],
      goalPrompt: 'Improve the new feature.',
      updatedAt: 2,
    });

    expect(result.files).toContain('src/new-feature.ts');
    expect(result.files).toContain('src/old-2.ts');
    expect(result.files).not.toContain('.env');
    expect(result.files).not.toContain('secrets/api-key.txt');
    expect(result.files.length).toBeLessThanOrEqual(WORKING_SET_MAX_FILES);
    expect(result.appliedInstructions).toEqual(current.appliedInstructions);
    expect(result.evictions).toEqual(
      expect.arrayContaining([
        { path: '.env', reason: 'sensitive-path', recordedAt: 2 },
        { path: 'secrets/api-key.txt', reason: 'sensitive-path', recordedAt: 2 },
      ]),
    );
  });

  it('enforces the total path budget and records why paths were omitted', () => {
    const longPath = (index: number) =>
      `src/${String(index).padStart(2, '0')}-${'x'.repeat(1_000)}.ts`;
    const result = maintainWorkingSet({
      current: { files: [], directories: [], rationale: 'empty', updatedAt: 1 },
      candidates: Array.from({ length: 30 }, (_, index) => longPath(index)),
      goalPrompt: 'Inspect source files.',
      updatedAt: 2,
    });
    expect(result.files.join('').length).toBeLessThanOrEqual(WORKING_SET_MAX_PATH_BUDGET);
    expect(result.evictions).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'path-budget', recordedAt: 2 })]),
    );
  });

  it('bounds directories and preserves deterministic ordering', () => {
    const result = maintainWorkingSet({
      current: {
        files: [],
        directories: Array.from({ length: 25 }, (_, index) => `packages/pkg-${index}`),
        rationale: 'many packages',
        updatedAt: 1,
      },
      updatedAt: 2,
    });
    expect(result.directories.length).toBe(20);
    expect(result.directories).toEqual([...result.directories].sort((a, b) => a.localeCompare(b)));
  });
});
