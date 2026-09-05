import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  FilesystemObserver,
  isGitignoredPath,
  isIgnoredPath,
  mergeChangeKinds,
  normalizeObservedPath,
  parseGitignore,
  type FileObservation,
  type FileObservationStat,
  type FileWatchFactory,
} from './index.js';

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

  it('applies common gitignore globs and last-match negation', () => {
    const rules = parseGitignore(`
# generated
*.log
build/
!important.log
`);
    expect(isGitignoredPath('debug.log', rules)).toBe(true);
    expect(isGitignoredPath('important.log', rules)).toBe(false);
    expect(isGitignoredPath('build/output.js', rules)).toBe(true);
    expect(isGitignoredPath('src/build/output.js', rules)).toBe(true);
  });

  it('debounces change storms and stops callbacks after cleanup', () => {
    vi.useFakeTimers();
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-files-'));
    const observations: Array<Pick<FileObservation, 'path' | 'kind'>> = [];
    let emit: Parameters<FileWatchFactory>[1] | undefined;
    let closed = false;
    try {
      const observer = new FilesystemObserver(
        {
          rootPath,
          debounceMs: 100,
          onChange: (observation: FileObservation) =>
            observations.push({ path: observation.path, kind: observation.kind }),
        },
        (_root, onEvent) => {
          emit = onEvent;
          return {
            close: () => {
              closed = true;
            },
          };
        },
      );
      observer.start();
      emit?.('change', 'src/app.ts');
      emit?.('change', 'src/app.ts');
      vi.advanceTimersByTime(99);
      expect(observations).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(observations).toEqual([{ path: 'src/app.ts', kind: 'modify' }]);

      observer.stop();
      expect(closed).toBe(true);
      emit?.('change', 'src/other.ts');
      vi.advanceTimersByTime(100);
      expect(observations).toHaveLength(1);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('records bounded lstat metadata without reading file contents', () => {
    vi.useFakeTimers();
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-files-'));
    const observations: FileObservation[] = [];
    let emit: Parameters<FileWatchFactory>[1] | undefined;
    try {
      fs.mkdirSync(path.join(rootPath, 'src'));
      fs.writeFileSync(path.join(rootPath, 'src/app.ts'), 'export const value = 1;\n', 'utf8');
      const observer = new FilesystemObserver(
        {
          rootPath,
          debounceMs: 100,
          onChange: (observation) => observations.push(observation),
        },
        (_root, onEvent) => {
          emit = onEvent;
          return { close: () => {} };
        },
      );
      observer.start();
      emit?.('change', 'src/app.ts');
      vi.advanceTimersByTime(100);

      const stat = observations[0]?.stat as FileObservationStat | undefined;
      expect(stat).toMatchObject({ isFile: true, isDirectory: false, isSymbolicLink: false });
      expect(stat?.size).toBeGreaterThan(0);
      expect(stat?.mtimeMs).toBeTypeOf('number');
      expect(observations[0]).not.toHaveProperty('content');
      observer.stop();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('coalesces a high-volume event storm by path', () => {
    vi.useFakeTimers();
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-files-'));
    const observations: Array<Pick<FileObservation, 'path' | 'kind'>> = [];
    let emit: Parameters<FileWatchFactory>[1] | undefined;
    try {
      const observer = new FilesystemObserver(
        {
          rootPath,
          debounceMs: 100,
          onChange: (observation: FileObservation) =>
            observations.push({ path: observation.path, kind: observation.kind }),
        },
        (_root, onEvent) => {
          emit = onEvent;
          return { close: () => {} };
        },
      );
      observer.start();
      for (let index = 0; index < 1_000; index += 1) {
        emit?.('change', `src/file-${index % 25}.ts`);
      }
      vi.advanceTimersByTime(100);

      expect(observations).toHaveLength(25);
      expect(new Set(observations.map((observation) => observation.path)).size).toBe(25);
      expect(observations.every((observation) => observation.kind === 'modify')).toBe(true);
      observer.stop();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
