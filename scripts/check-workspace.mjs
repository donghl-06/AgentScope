import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const workspaceText = await readFile(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
const workspacePatterns = workspaceText
  .split(/\r?\n/)
  .map((line) => line.match(/^\s+-\s+(.+)\s*$/)?.[1])
  .filter((pattern) => pattern !== undefined);
if (workspacePatterns.length === 0) {
  throw new Error('pnpm-workspace.yaml must declare at least one workspace pattern');
}

const rootPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
for (const script of ['lint', 'typecheck', 'test', 'build', 'dev']) {
  if (typeof rootPackage.scripts?.[script] !== 'string') {
    throw new Error(`Root package.json is missing the ${script} script`);
  }
}

console.log(`Workspace manifest check passed (${workspacePatterns.length} patterns).`);
