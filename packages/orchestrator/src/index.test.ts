import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bootstrapProjectContext } from './index.js';

async function withWorkspace(test: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-context-'));
  try {
    await test(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

describe('bootstrapProjectContext', () => {
  it('collects deterministic project facts without reading sensitive files', async () => {
    await withWorkspace(async (workspace) => {
      fs.writeFileSync(
        path.join(workspace, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc --noEmit', private: 'echo' } }),
      );
      fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      fs.writeFileSync(path.join(workspace, 'README.md'), '# Example\n');
      fs.writeFileSync(path.join(workspace, '.env'), 'SHOULD_NOT_BE_READ=secret\n');
      fs.mkdirSync(path.join(workspace, 'src'));
      fs.mkdirSync(path.join(workspace, 'node_modules'));

      const context = await bootstrapProjectContext({
        workspace,
        goalPrompt: 'Improve the typecheck workflow in src.',
        now: 123,
      });

      expect(context.projectState.workspace).toBe(path.resolve(workspace));
      expect(context.projectState.packageManager).toBe('pnpm');
      expect(context.projectState.readmePath).toBe('README.md');
      expect(context.projectState.techStack).toContain('Node.js/TypeScript');
      expect(context.projectState.topLevelDirectories).toEqual(['src']);
      expect(context.projectState.discoverableVerification).toMatchObject([
        { id: 'package-script:typecheck', executable: 'pnpm', args: ['run', 'typecheck'] },
        { id: 'package-script:test', executable: 'pnpm', args: ['run', 'test'] },
      ]);
      expect(context.projectState.relevantFiles).toEqual(['package.json']);
      expect(context.workingSet.files).toEqual(['package.json']);
      expect(context.executionMemory).toEqual({
        decisions: [],
        completedTaskIds: [],
        failedApproaches: [],
        notes: [],
      });
    });
  });

  it('rejects a missing workspace before invoking any provider', async () => {
    await expect(
      bootstrapProjectContext({
        workspace: path.join(os.tmpdir(), 'missing-agentscope-context'),
        goalPrompt: 'x',
      }),
    ).rejects.toThrow('Workspace does not exist');
  });
});
