import type { StoredTask } from '@agentscope/storage';

import type { ProjectState, WorkingSet } from './index.js';

export interface WorkerLaunchRequest {
  readonly attemptId: string;
  readonly provider: string;
  readonly workspace: string;
  readonly task: StoredTask;
  readonly prompt: string;
  readonly projectState: ProjectState;
  readonly workingSet: WorkingSet;
}

export interface WorkerExecutionResult {
  readonly attemptId: string;
  readonly sessionId?: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly exitCode: number;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly reportedVerification: Readonly<Record<string, unknown>>;
}

export type WorkerLauncher = (request: WorkerLaunchRequest) => Promise<WorkerExecutionResult>;

export class WorkerBusyError extends Error {
  constructor(readonly activeAttemptId: string) {
    super(`A Worker is already active for Attempt ${activeAttemptId}.`);
    this.name = 'WorkerBusyError';
  }
}

export class WorkerRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkerRuntimeError';
  }
}

export interface WorkerRuntimeOptions {
  readonly launch: WorkerLauncher;
}

/** Serial Worker boundary shared by CLI and the future server orchestrator. */
export class SerialWorkerRuntime {
  private activeAttemptId: string | undefined;

  constructor(private readonly options: WorkerRuntimeOptions) {}

  get active(): boolean {
    return this.activeAttemptId !== undefined;
  }

  get activeAttempt(): string | undefined {
    return this.activeAttemptId;
  }

  async execute(input: {
    readonly attemptId: string;
    readonly provider: string;
    readonly workspace: string;
    readonly task: StoredTask;
    readonly projectState: ProjectState;
    readonly workingSet: WorkingSet;
  }): Promise<WorkerExecutionResult> {
    if (this.activeAttemptId !== undefined) throw new WorkerBusyError(this.activeAttemptId);
    this.activeAttemptId = input.attemptId;
    try {
      const request: WorkerLaunchRequest = {
        ...input,
        prompt: buildWorkerPrompt(input.task, input.projectState, input.workingSet),
      };
      const result = await this.options.launch(request);
      if (result.attemptId !== input.attemptId) {
        throw new WorkerRuntimeError(
          `Worker launcher returned Attempt ${result.attemptId} for ${input.attemptId}.`,
        );
      }
      return result;
    } finally {
      this.activeAttemptId = undefined;
    }
  }
}

export function buildWorkerPrompt(
  task: StoredTask,
  projectState: ProjectState,
  workingSet: WorkingSet,
): string {
  const checks = Array.isArray(task.verification.checks)
    ? task.verification.checks
        .filter(isVerificationCheck)
        .map((check) => `${check.executable} ${check.args.join(' ')}`.trim())
    : [];
  return [
    'You are the single coding Worker inside AgentScope Orchestrator.',
    'Work only on the current Task Contract in the provided workspace.',
    'Do not start another agent, do not push to a remote, and do not claim completion without doing the work.',
    '',
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    'Constraints:',
    ...Object.entries(task.constraints).map(([key, value]) => `- ${key}: ${String(value)}`),
    `Workspace: ${projectState.workspace}`,
    `Working set: ${workingSet.files.join(', ') || '(none selected)'}`,
    ...(checks.length === 0
      ? []
      : ['Discoverable verification commands:', ...checks.map((check) => `- ${check}`)]),
    '',
    'At the end, summarize what changed, list changed files, and report verification honestly.',
  ].join('\n');
}

function isVerificationCheck(value: unknown): value is { executable: string; args: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.executable === 'string' &&
    Array.isArray(record.args) &&
    record.args.every((arg): arg is string => typeof arg === 'string')
  );
}
