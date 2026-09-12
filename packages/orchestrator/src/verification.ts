import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { GitObserver, type GitSnapshot } from '@agentscope/observer-git';
import type { StoredTask } from '@agentscope/storage';

import type { ProjectState, VerificationCommand } from './index.js';
import type { WorkerExecutionResult } from './worker.js';

const execFileAsync = promisify(execFile);

export type CriterionStatus = 'PASS' | 'FAIL' | 'UNCERTAIN';

export interface CommandCheckEvidence {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly status: CriterionStatus;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly timedOut: boolean;
  readonly reason: string;
}

export interface GitCheckEvidence {
  readonly isRepository: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly changedFiles: readonly string[];
  readonly diffFiles: readonly string[];
  readonly reason: string;
}

export interface AcceptanceCriterionResult {
  readonly criterion: string;
  readonly status: CriterionStatus;
  readonly reason: string;
}

export interface VerificationResult {
  readonly status: CriterionStatus;
  readonly criteria: readonly AcceptanceCriterionResult[];
  readonly deterministicChecks: readonly CommandCheckEvidence[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly reason: string;
}

export interface VerificationCommandRunResult {
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly timedOut: boolean;
  readonly reason?: string;
}

export type VerificationCommandRunner = (
  command: VerificationCommand,
  workspace: string,
  timeoutMs: number,
) => Promise<VerificationCommandRunResult>;

export interface VerifyTaskOptions {
  readonly workspace: string;
  readonly task: StoredTask;
  readonly projectState: ProjectState;
  readonly workerResult?: WorkerExecutionResult;
  readonly gitObserver?: GitObserver;
  readonly runCommand?: VerificationCommandRunner;
  readonly commandTimeoutMs?: number;
}

export async function verifyTask(options: VerifyTaskOptions): Promise<VerificationResult> {
  const workspace = path.resolve(options.workspace);
  const timeoutMs = validateTimeout(options.commandTimeoutMs ?? 120_000);
  const git = await (options.gitObserver ?? new GitObserver({ rootPath: workspace })).capture();
  const gitEvidence = toGitEvidence(git);
  const commands = extractVerificationCommands(options.task);
  const runCommand = options.runCommand ?? runVerificationCommand;
  const deterministicChecks: CommandCheckEvidence[] = [];
  for (const command of commands) {
    deterministicChecks.push(await runCheck(command, workspace, timeoutMs, runCommand));
  }

  const criteria = options.task.acceptanceCriteria.map((criterion) => {
    const commandFailure = deterministicChecks.find((check) => check.status === 'FAIL');
    if (commandFailure !== undefined) {
      return {
        criterion,
        status: 'FAIL' as const,
        reason: `Deterministic check failed: ${commandFailure.label}.`,
      };
    }
    if (deterministicChecks.length === 0) {
      return {
        criterion,
        status: 'UNCERTAIN' as const,
        reason: 'No structured deterministic verification command was provided.',
      };
    }
    if (deterministicChecks.some((check) => check.status === 'UNCERTAIN')) {
      return {
        criterion,
        status: 'UNCERTAIN' as const,
        reason: 'At least one deterministic check could not be completed safely.',
      };
    }
    if (options.workerResult?.status !== undefined && options.workerResult.status !== 'completed') {
      return {
        criterion,
        status: 'UNCERTAIN' as const,
        reason: 'Worker did not report a completed execution; evidence cannot promote the claim.',
      };
    }
    return { criterion, status: 'PASS' as const, reason: 'All deterministic checks passed.' };
  });
  const status = combineStatuses(criteria.map((criterion) => criterion.status));
  const evidence: Record<string, unknown>[] = [
    { kind: 'git', ...gitEvidence },
    ...deterministicChecks.map((check) => ({ kind: 'command', ...check })),
  ];
  return {
    status,
    criteria,
    deterministicChecks,
    evidence,
    reason: verificationReason(status, gitEvidence, deterministicChecks),
  };
}

export function extractVerificationCommands(task: StoredTask): readonly VerificationCommand[] {
  const value = task.verification.checks;
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!isVerificationCommand(candidate)) return [];
    return [
      {
        id: candidate.id ?? `${task.id}:check:${index + 1}`,
        label: candidate.label ?? `${candidate.executable} ${candidate.args.join(' ')}`,
        executable: candidate.executable,
        args: candidate.args,
        source: 'workspace-convention' as const,
      },
    ];
  });
}

async function runCheck(
  command: VerificationCommand,
  workspace: string,
  timeoutMs: number,
  runCommand: VerificationCommandRunner,
): Promise<CommandCheckEvidence> {
  if (!isSafeVerificationCommand(command)) {
    return {
      id: command.id,
      label: command.label,
      executable: command.executable,
      args: command.args,
      durationMs: 0,
      status: 'UNCERTAIN',
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      reason: 'Executable or argument contains an unsafe shell-like value.',
    };
  }
  const startedAt = Date.now();
  const result = await runCommand(command, workspace, timeoutMs);
  const durationMs = Math.max(0, Date.now() - startedAt);
  const status =
    result.timedOut || result.exitCode === null
      ? 'UNCERTAIN'
      : result.exitCode === 0
        ? 'PASS'
        : 'FAIL';
  return {
    id: command.id,
    label: command.label,
    executable: command.executable,
    args: command.args,
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    durationMs,
    status,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    timedOut: result.timedOut,
    reason:
      result.reason ??
      (status === 'PASS'
        ? 'Command exited successfully.'
        : status === 'FAIL'
          ? 'Command exited with a non-zero code.'
          : 'Command outcome is unavailable.'),
  };
}

async function runVerificationCommand(
  command: VerificationCommand,
  workspace: string,
  timeoutMs: number,
): Promise<VerificationCommandRunResult> {
  const env = sanitizedEnvironment(process.env);
  try {
    const result = await execFileAsync(command.executable, [...command.args], {
      cwd: workspace,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return {
      exitCode: 0,
      stdoutBytes: byteLength(result.stdout),
      stderrBytes: byteLength(result.stderr),
      timedOut: false,
    };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const timedOut = failure.killed === true || failure.signal === 'SIGTERM';
    const numericCode = typeof failure.code === 'number' ? failure.code : undefined;
    return {
      exitCode: numericCode ?? (timedOut ? null : 1),
      stdoutBytes: byteLength(failure.stdout),
      stderrBytes: byteLength(failure.stderr),
      timedOut,
      ...(failure.message === undefined ? {} : { reason: failure.message.slice(0, 240) }),
    };
  }
}

function toGitEvidence(snapshot: GitSnapshot): GitCheckEvidence {
  return {
    isRepository: snapshot.isRepository,
    ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
    ...(snapshot.head === undefined ? {} : { head: snapshot.head }),
    changedFiles: snapshot.files.map((file) => file.path),
    diffFiles: snapshot.diffStat.map((file) => file.path),
    reason:
      snapshot.reason ??
      (snapshot.isRepository ? 'Git snapshot captured.' : 'Workspace is not a Git repository.'),
  };
}

function combineStatuses(statuses: readonly CriterionStatus[]): CriterionStatus {
  if (statuses.length === 0 || statuses.some((status) => status === 'UNCERTAIN'))
    return 'UNCERTAIN';
  if (statuses.some((status) => status === 'FAIL')) return 'FAIL';
  return 'PASS';
}

function verificationReason(
  status: CriterionStatus,
  git: GitCheckEvidence,
  checks: readonly CommandCheckEvidence[],
): string {
  if (status === 'PASS') return 'All acceptance criteria have passing deterministic evidence.';
  if (status === 'FAIL') return 'At least one deterministic verification command failed.';
  if (!git.isRepository && checks.length === 0)
    return 'No Git or deterministic command evidence is available.';
  return 'Evidence is incomplete or uncertain; do not claim completion.';
}

function isVerificationCommand(value: unknown): value is {
  readonly id?: string;
  readonly label?: string;
  readonly executable: string;
  readonly args: readonly string[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.executable === 'string' &&
    Array.isArray(record.args) &&
    record.args.every((arg): arg is string => typeof arg === 'string') &&
    (record.id === undefined || typeof record.id === 'string') &&
    (record.label === undefined || typeof record.label === 'string')
  );
}

function isSafeVerificationCommand(command: VerificationCommand): boolean {
  const executable = path
    .basename(command.executable)
    .toLowerCase()
    .replace(/\.cmd$|\.exe$|\.bat$/u, '');
  const allowed = new Set([
    'pnpm',
    'npm',
    'yarn',
    'bun',
    'node',
    'git',
    'python',
    'python3',
    'pytest',
    'cargo',
    'go',
    'dotnet',
    'mvn',
    'gradle',
  ]);
  if (!allowed.has(executable)) return false;
  return ![command.executable, ...command.args].some((value) => /[;&|<>`$]/u.test(value));
}

function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key),
    ),
  );
}

function byteLength(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 10 * 60_000) {
    throw new RangeError('commandTimeoutMs must be an integer between 100 and 600000.');
  }
  return value;
}
