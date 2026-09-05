import { describe, expect, it, vi } from 'vitest';

import { GitObserver, parsePorcelainZ, type GitCommandResult } from './index.js';

describe('git observer', () => {
  it('parses machine-readable status including renames', () => {
    expect(parsePorcelainZ(' M src/app.ts\0?? notes.txt\0R  old.ts\0new.ts\0')).toEqual([
      { path: 'src/app.ts', indexStatus: ' ', worktreeStatus: 'M' },
      { path: 'notes.txt', indexStatus: '?', worktreeStatus: '?' },
      { path: 'new.ts', indexStatus: 'R', worktreeStatus: ' ', previousPath: 'old.ts' },
    ]);
  });

  it('captures a baseline and computes only changes after it', async () => {
    let current = 0;
    const run = vi.fn(async (_cwd: string, args: readonly string[]): Promise<GitCommandResult> => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return result('C:/repo\n');
      if (args[0] === 'branch') return result(current === 0 ? 'main\n' : 'feature\n');
      if (args[0] === 'rev-parse') return result(current === 0 ? 'aaa\n' : 'bbb\n');
      if (args[0] === 'status')
        return result(current === 0 ? ' M existing.ts\0' : ' M changed.ts\0?? new.ts\0');
      return result('', 1, 'unknown command');
    });
    const observer = new GitObserver({ rootPath: 'C:/repo', now: () => 10 }, run);

    await observer.captureBaseline();
    current = 1;
    await expect(observer.changesSinceBaseline()).resolves.toEqual({
      added: ['changed.ts', 'new.ts'],
      modified: [],
      deleted: ['existing.ts'],
      renamed: [],
      branchChanged: true,
      baselineAvailable: true,
    });
  });

  it('degrades cleanly outside a repository', async () => {
    const run = vi.fn(async () => result('', 128, 'fatal: not a git repository'));
    await expect(new GitObserver({ rootPath: 'C:/tmp' }, run).capture()).resolves.toMatchObject({
      isRepository: false,
      files: [],
    });
  });
});

function result(stdout: string, exitCode = 0, stderr = ''): GitCommandResult {
  return { stdout, stderr, exitCode };
}
