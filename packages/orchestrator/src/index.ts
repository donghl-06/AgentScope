import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GitObserver, type GitSnapshot } from '@agentscope/observer-git';

const execFileAsync = promisify(execFile);

export interface VerificationCommand {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly source: 'package-script' | 'workspace-convention';
}

export interface ProjectManifestSummary {
  readonly path: string;
  readonly kind: string;
  readonly present: boolean;
  readonly scripts?: readonly string[];
}

export interface ProjectState {
  readonly workspace: string;
  readonly capturedAt: number;
  readonly git: GitSnapshot;
  readonly packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
  readonly manifests: readonly ProjectManifestSummary[];
  readonly readmePath?: string;
  readonly techStack: readonly string[];
  readonly topLevelDirectories: readonly string[];
  readonly discoverableVerification: readonly VerificationCommand[];
  readonly recentCommits: readonly string[];
  readonly relevantFiles: readonly string[];
}

export interface ExecutionMemory {
  readonly decisions: readonly ExecutionDecision[];
  readonly completedTaskIds: readonly string[];
  readonly failedApproaches: readonly string[];
  readonly notes: readonly string[];
}

export interface ExecutionDecision {
  readonly id: string;
  readonly summary: string;
  readonly status: 'LOCKED' | 'STABLE' | 'TENTATIVE';
  readonly source: 'user' | 'planner' | 'verifier' | 'system';
  readonly recordedAt: number;
}

export interface WorkingSet {
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly rationale: string;
  readonly updatedAt: number;
}

export interface BootstrapContext {
  readonly projectState: ProjectState;
  readonly executionMemory: ExecutionMemory;
  readonly workingSet: WorkingSet;
}

export interface BootstrapOptions {
  readonly workspace: string;
  readonly goalPrompt: string;
  readonly now?: number;
  readonly gitObserver?: GitObserver;
  readonly recentCommitLimit?: number;
}

const MANIFESTS: readonly { readonly filename: string; readonly kind: string }[] = [
  { filename: 'package.json', kind: 'node' },
  { filename: 'pnpm-workspace.yaml', kind: 'pnpm-workspace' },
  { filename: 'pyproject.toml', kind: 'python' },
  { filename: 'requirements.txt', kind: 'python-requirements' },
  { filename: 'Cargo.toml', kind: 'rust' },
  { filename: 'go.mod', kind: 'go' },
  { filename: 'pom.xml', kind: 'java-maven' },
  { filename: 'build.gradle', kind: 'java-gradle' },
];

const IGNORED_PATH_SEGMENTS = new Set([
  '.git',
  '.agentscope',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.turbo',
]);

const SECRET_PATH_PATTERN = /(^|\/)(?:\.env(?:\.|$)|.*(?:secret|token|credential|key).*)/iu;

export async function bootstrapProjectContext(
  options: BootstrapOptions,
): Promise<BootstrapContext> {
  const workspace = path.resolve(options.workspace);
  assertWorkspace(workspace);
  const capturedAt = options.now ?? Date.now();
  const gitObserver = options.gitObserver ?? new GitObserver({ rootPath: workspace });
  const git = await gitObserver.capture();
  const packageManager = detectPackageManager(workspace);
  const manifests = readManifestSummaries(workspace);
  const readmePath = findReadme(workspace);
  const techStack = detectTechStack(manifests, git.trackedFiles);
  const topLevelDirectories = listTopLevelDirectories(workspace);
  const discoverableVerification = discoverVerificationCommands(packageManager, manifests);
  const recentCommits = await readRecentCommits(workspace, options.recentCommitLimit ?? 5);
  const relevantFiles = selectRelevantFiles(git.trackedFiles, options.goalPrompt, manifests);
  const projectState: ProjectState = {
    workspace,
    capturedAt,
    git,
    packageManager,
    manifests,
    ...(readmePath === undefined ? {} : { readmePath }),
    techStack,
    topLevelDirectories,
    discoverableVerification,
    recentCommits,
    relevantFiles,
  };
  const workingSet: WorkingSet = {
    files: relevantFiles,
    directories: topLevelDirectories.filter((directory) =>
      relevantFiles.some((file) => file === directory || file.startsWith(`${directory}/`)),
    ),
    rationale: 'Selected deterministically from Goal keywords, manifests, and tracked paths.',
    updatedAt: capturedAt,
  };
  return {
    projectState,
    executionMemory: {
      decisions: [],
      completedTaskIds: [],
      failedApproaches: [],
      notes: [],
    },
    workingSet,
  };
}

function assertWorkspace(workspace: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspace);
  } catch (error) {
    throw new Error(`Workspace does not exist: ${workspace}`, { cause: error });
  }
  if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
}

function detectPackageManager(workspace: string): ProjectState['packageManager'] {
  if (exists(workspace, 'pnpm-lock.yaml') || exists(workspace, 'pnpm-workspace.yaml'))
    return 'pnpm';
  if (exists(workspace, 'yarn.lock')) return 'yarn';
  if (exists(workspace, 'bun.lockb') || exists(workspace, 'bun.lock')) return 'bun';
  if (exists(workspace, 'package-lock.json')) return 'npm';
  return 'unknown';
}

function readManifestSummaries(workspace: string): readonly ProjectManifestSummary[] {
  return MANIFESTS.flatMap(({ filename, kind }) => {
    const filenamePath = path.join(workspace, filename);
    if (!exists(workspace, filename)) return [];
    if (filename !== 'package.json') return [{ path: filename, kind, present: true }];
    try {
      const value = JSON.parse(fs.readFileSync(filenamePath, 'utf8')) as Record<string, unknown>;
      const scriptsValue = value.scripts;
      const scripts =
        typeof scriptsValue === 'object' && scriptsValue !== null
          ? Object.keys(scriptsValue).sort()
          : [];
      return [{ path: filename, kind, present: true, scripts }];
    } catch {
      return [{ path: filename, kind, present: true, scripts: [] }];
    }
  });
}

function findReadme(workspace: string): string | undefined {
  const entries = fs.readdirSync(workspace, { withFileTypes: true });
  const readme = entries
    .filter((entry) => entry.isFile() && /^readme(?:\.[^.]+)?$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))[0];
  return readme === undefined ? undefined : readme;
}

function detectTechStack(
  manifests: readonly ProjectManifestSummary[],
  trackedFiles: readonly string[],
): readonly string[] {
  const stack = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest.present) continue;
    if (manifest.kind === 'node' || manifest.kind === 'pnpm-workspace')
      stack.add('Node.js/TypeScript');
    if (manifest.kind.startsWith('python')) stack.add('Python');
    if (manifest.kind === 'rust') stack.add('Rust');
    if (manifest.kind === 'go') stack.add('Go');
    if (manifest.kind.startsWith('java')) stack.add('Java');
  }
  for (const file of trackedFiles) {
    if (/\.(?:ts|tsx)$/iu.test(file)) stack.add('TypeScript');
    else if (/\.(?:js|jsx|mjs|cjs)$/iu.test(file)) stack.add('JavaScript');
    else if (/\.py$/iu.test(file)) stack.add('Python');
    else if (/\.rs$/iu.test(file)) stack.add('Rust');
    else if (/\.go$/iu.test(file)) stack.add('Go');
  }
  return [...stack].sort();
}

function listTopLevelDirectories(workspace: string): readonly string[] {
  return fs
    .readdirSync(workspace, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !IGNORED_PATH_SEGMENTS.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function discoverVerificationCommands(
  packageManager: ProjectState['packageManager'],
  manifests: readonly ProjectManifestSummary[],
): readonly VerificationCommand[] {
  const nodeManifest = manifests.find((manifest) => manifest.path === 'package.json');
  if (nodeManifest === undefined || nodeManifest.scripts === undefined) return [];
  const executable = packageManager === 'unknown' ? undefined : packageManager;
  if (executable === undefined) return [];
  const preferred = ['lint', 'typecheck', 'test', 'test:integration', 'build'];
  return preferred
    .filter((script) => nodeManifest.scripts?.includes(script))
    .map((script) => ({
      id: `package-script:${script}`,
      label: `${executable} run ${script}`,
      executable,
      args: ['run', script],
      source: 'package-script' as const,
    }));
}

async function readRecentCommits(workspace: string, limit: number): Promise<readonly string[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  try {
    const result = await execFileAsync('git', ['log', `-${Math.min(limit, 20)}`, '--oneline'], {
      cwd: workspace,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
    return result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function selectRelevantFiles(
  trackedFiles: readonly string[],
  goalPrompt: string,
  manifests: readonly ProjectManifestSummary[],
): readonly string[] {
  const tokens = tokenize(goalPrompt);
  const candidates = trackedFiles.filter((file) => !isSensitivePath(file));
  const scored = candidates.map((file) => ({
    file,
    score: scorePath(file, tokens),
  }));
  const selected = scored
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, 40)
    .map(({ file }) => file);
  for (const manifest of manifests)
    if (manifest.present && !selected.includes(manifest.path)) selected.push(manifest.path);
  return selected.slice(0, 50).sort((left, right) => left.localeCompare(right));
}

function tokenize(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/giu) ?? [])];
}

function scorePath(file: string, tokens: readonly string[]): number {
  const normalized = file.toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 2 : 0), 0);
}

function isSensitivePath(file: string): boolean {
  return (
    SECRET_PATH_PATTERN.test(file) ||
    file.split('/').some((segment) => IGNORED_PATH_SEGMENTS.has(segment))
  );
}

function exists(workspace: string, filename: string): boolean {
  return fs.existsSync(path.join(workspace, filename));
}

export * from './planner.js';
export * from './worker.js';
export * from './verification.js';
