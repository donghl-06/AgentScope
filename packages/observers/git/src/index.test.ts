import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { GitObserver, parseNumstat, parsePorcelainZ, type GitCommandResult } from './index.js';

const execFileAsync = promisify(execFile);

describe('git observer', () => {
  it('parses machine-readable status including renames', () => {
    expect(parsePorcelainZ(' M src/app.ts\0?? notes.txt\0R  old.ts\0new.ts\0')).toEqual([
      { path: 'src/app.ts', indexStatus: ' ', worktreeStatus: 'M' },
      { path: 'notes.txt', indexStatus: '?', worktreeStatus: '?' },
      { path: 'new.ts', indexStatus: 'R', worktreeStatus: ' ', previousPath: 'old.ts' },
    ]);
  });

  it('parses numstat without reading diff contents', () => {
    expect(parseNumstat('3\t1\tsrc/app.ts\n-\t-\tassets/logo.png\n')).toEqual([
      { path: 'src/app.ts', additions: 3, deletions: 1 },
      { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
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

  it('tracks baseline changes and committed head changes in a temporary repository', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-git-'));
    try {
      await runGit(rootPath, ['init', '-q']);
      await runGit(rootPath, ['config', 'user.name', 'AgentScope Test']);
      await runGit(rootPath, ['config', 'user.email', 'agentscope-test@example.invalid']);
      await fs.writeFile(path.join(rootPath, 'existing.txt'), 'before\n', 'utf8');
      await runGit(rootPath, ['add', 'existing.txt']);
      await runGit(rootPath, ['commit', '-q', '-m', 'initial']);

      const observer = new GitObserver({ rootPath, now: () => 100 });
      await observer.captureBaseline();
      await fs.writeFile(path.join(rootPath, 'existing.txt'), 'after\n', 'utf8');
      await fs.writeFile(path.join(rootPath, 'added.txt'), 'new\n', 'utf8');
      await fs.rm(path.join(rootPath, 'existing.txt'));

      await expect(observer.changesSinceBaseline()).resolves.toMatchObject({
        added: ['added.txt'],
        modified: [],
        deleted: ['existing.txt'],
        renamed: [],
        branchChanged: false,
        baselineAvailable: true,
      });

      await runGit(rootPath, ['add', '-A']);
      await runGit(rootPath, ['commit', '-q', '-m', 'change']);
      await expect(observer.changesSinceBaseline()).resolves.toMatchObject({
        added: [],
        modified: [],
        deleted: [],
        renamed: [],
        branchChanged: true,
        baselineAvailable: true,
      });
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});

function result(stdout: string, exitCode = 0, stderr = ''): GitCommandResult {
  return { stdout, stderr, exitCode };
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}
