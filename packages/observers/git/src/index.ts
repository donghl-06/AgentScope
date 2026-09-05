import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export interface GitFileStatus {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly previousPath?: string;
}

export interface GitSnapshot {
  readonly rootPath: string;
  readonly isRepository: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly files: readonly GitFileStatus[];
  readonly trackedFiles: readonly string[];
  readonly diffStat: readonly GitDiffStat[];
  readonly capturedAt: number;
  readonly reason?: string;
}

export interface GitDiffStat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary?: boolean;
}

export interface GitChangeSet {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly { from: string; to: string }[];
  readonly branchChanged: boolean;
  readonly baselineAvailable: boolean;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type GitCommandRunner = (cwd: string, args: readonly string[]) => Promise<GitCommandResult>;

export interface GitObserverOptions {
  readonly rootPath: string;
  readonly now?: () => number;
}

export class GitObserver {
  private readonly rootPath: string;
  private readonly now: () => number;
  private baseline?: GitSnapshot;

  constructor(
    options: GitObserverOptions,
    private readonly run: GitCommandRunner = runGitCommand,
  ) {
    this.rootPath = resolve(options.rootPath);
    this.now = options.now ?? Date.now;
  }

  async capture(): Promise<GitSnapshot> {
    const root = await this.run(this.rootPath, ['rev-parse', '--show-toplevel']);
    if (root.exitCode !== 0) {
      return {
        rootPath: this.rootPath,
        isRepository: false,
        files: [],
        trackedFiles: [],
        diffStat: [],
        capturedAt: this.now(),
        reason: root.stderr.trim() || 'Not a Git repository.',
      };
    }

    const [branch, head, status, tracked, unstagedDiff, stagedDiff] = await Promise.all([
      this.run(this.rootPath, ['branch', '--show-current']),
      this.run(this.rootPath, ['rev-parse', 'HEAD']),
      this.run(this.rootPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.run(this.rootPath, ['ls-files', '-z']),
      this.run(this.rootPath, ['diff', '--numstat', '--no-renames']),
      this.run(this.rootPath, ['diff', '--cached', '--numstat', '--no-renames']),
    ]);
    const diffStat = mergeDiffStats(
      unstagedDiff.exitCode === 0 ? parseNumstat(unstagedDiff.stdout) : [],
      stagedDiff.exitCode === 0 ? parseNumstat(stagedDiff.stdout) : [],
    );
    return {
      rootPath: normalizeRoot(root.stdout, this.rootPath),
      isRepository: true,
      ...(branch.stdout.trim() === '' ? {} : { branch: branch.stdout.trim() }),
      ...(head.stdout.trim() === '' ? {} : { head: head.stdout.trim() }),
      files: status.exitCode === 0 ? parsePorcelainZ(status.stdout) : [],
      trackedFiles: tracked.exitCode === 0 ? parseTrackedFiles(tracked.stdout) : [],
      diffStat,
      capturedAt: this.now(),
      ...(status.exitCode === 0 ? {} : { reason: status.stderr.trim() || 'Git status failed.' }),
    };
  }

  async captureBaseline(): Promise<GitSnapshot> {
    this.baseline = await this.capture();
    return this.baseline;
  }

  async changesSinceBaseline(): Promise<GitChangeSet> {
    const current = await this.capture();
    const baseline = this.baseline;
    if (baseline === undefined || !baseline.isRepository || !current.isRepository) {
      return {
        added: [],
        modified: [],
        deleted: [],
        renamed: [],
        branchChanged: baseline?.branch !== current.branch,
        baselineAvailable: false,
      };
    }

    const before = new Map(baseline.files.map((file) => [file.path, file]));
    const after = new Map(current.files.map((file) => [file.path, file]));
    const trackedBefore = new Set(baseline.trackedFiles);
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const renamed: Array<{ from: string; to: string }> = [];
    for (const [path, file] of after) {
      const previous = before.get(path);
      if (previous === undefined) {
        if (file.previousPath !== undefined) renamed.push({ from: file.previousPath, to: path });
        else if (trackedBefore.has(path) && isDeletion(file)) deleted.push(path);
        else if (trackedBefore.has(path)) modified.push(path);
        else added.push(path);
      } else if (
        previous.indexStatus !== file.indexStatus ||
        previous.worktreeStatus !== file.worktreeStatus
      ) {
        modified.push(path);
      }
    }
    for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
    return {
      added: added.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
      renamed: renamed.sort((left, right) => left.to.localeCompare(right.to)),
      branchChanged: baseline.branch !== current.branch || baseline.head !== current.head,
      baselineAvailable: true,
    };
  }
}

export function parsePorcelainZ(output: string): readonly GitFileStatus[] {
  const tokens = output.split('\0');
  const files: GitFileStatus[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length < 4) continue;
    const indexStatus = token[0] ?? ' ';
    const worktreeStatus = token[1] ?? ' ';
    const path = normalizeGitPath(token.slice(3));
    if (path.length === 0) continue;
    const renameLike = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R';
    if (renameLike) {
      const next = tokens[index + 1];
      if (next !== undefined && next.length > 0) {
        index += 1;
        files.push({
          path: normalizeGitPath(next),
          indexStatus,
          worktreeStatus,
          previousPath: path,
        });
        continue;
      }
    }
    files.push({ path, indexStatus, worktreeStatus });
  }
  return files;
}

export function parseTrackedFiles(output: string): readonly string[] {
  return output
    .split('\0')
    .filter((path) => path.length > 0)
    .map(normalizeGitPath)
    .sort();
}

export function parseNumstat(output: string): readonly GitDiffStat[] {
  const entries: GitDiffStat[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const separator = line.indexOf('\t');
    const secondSeparator = separator < 0 ? -1 : line.indexOf('\t', separator + 1);
    if (separator < 0 || secondSeparator < 0) continue;
    const additionsText = line.slice(0, separator);
    const deletionsText = line.slice(separator + 1, secondSeparator);
    const path = normalizeGitPath(line.slice(secondSeparator + 1));
    if (path.length === 0) continue;
    if (additionsText === '-' || deletionsText === '-') {
      entries.push({ path, additions: 0, deletions: 0, binary: true });
      continue;
    }
    const additions = Number(additionsText);
    const deletions = Number(deletionsText);
    if (
      Number.isInteger(additions) &&
      Number.isInteger(deletions) &&
      additions >= 0 &&
      deletions >= 0
    ) {
      entries.push({ path, additions, deletions });
    }
  }
  return entries;
}

function mergeDiffStats(...groups: readonly (readonly GitDiffStat[])[]): readonly GitDiffStat[] {
  const merged = new Map<string, GitDiffStat>();
  for (const group of groups) {
    for (const stat of group) {
      const previous = merged.get(stat.path);
      if (previous === undefined) merged.set(stat.path, stat);
      else {
        merged.set(stat.path, {
          path: stat.path,
          additions: previous.additions + stat.additions,
          deletions: previous.deletions + stat.deletions,
          ...(previous.binary || stat.binary ? { binary: true } : {}),
        });
      }
    }
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function runGitCommand(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

function normalizeRoot(value: string, fallback: string): string {
  const root = value.trim();
  return root.length === 0 ? fallback : resolve(root);
}

function normalizeGitPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isDeletion(file: GitFileStatus): boolean {
  return file.indexStatus === 'D' || file.worktreeStatus === 'D';
}
