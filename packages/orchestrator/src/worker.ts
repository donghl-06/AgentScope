import type { JsonObject, StoredTask, WorkerUsage } from '@agentscope/storage';

import type { ProjectState, WorkingSet } from './index.js';

export interface WorkerLaunchRequest {
  readonly attemptId: string;
  readonly provider: string;
  readonly workspace: string;
  readonly task: StoredTask;
  readonly prompt: string;
  readonly projectState: ProjectState;
  readonly workingSet: WorkingSet;
  readonly retryContext?: WorkerRetryContext;
}

export interface WorkerRetryContext {
  readonly previousAttemptId?: string;
  readonly previousAttemptNumber?: number;
  readonly previousAttemptStatus?: string;
  readonly previousVerificationStatus?: string;
  readonly previousVerificationReason?: string;
  readonly previousVerificationEvidence: readonly JsonObject[];
  readonly repairObjective: string;
}

export interface WorkerExecutionResult {
  readonly attemptId: string;
  readonly sessionId?: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly exitCode: number;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly reportedVerification: Readonly<Record<string, unknown>>;
  /** Usage reported by the Provider; AgentScope never estimates missing values. */
  readonly usage?: WorkerUsage;
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
    readonly retryContext?: WorkerRetryContext;
  }): Promise<WorkerExecutionResult> {
    if (this.activeAttemptId !== undefined) throw new WorkerBusyError(this.activeAttemptId);
    this.activeAttemptId = input.attemptId;
    try {
      const request: WorkerLaunchRequest = {
        ...input,
        prompt: buildWorkerPrompt(
          input.task,
          input.projectState,
          input.workingSet,
          input.retryContext,
        ),
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
  retryContext?: WorkerRetryContext,
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
    ...formatAppliedInstructions(workingSet),
    ...(checks.length === 0
      ? []
      : ['Discoverable verification commands:', ...checks.map((check) => `- ${check}`)]),
    ...formatRetryContext(retryContext),
    '',
    'At the end, summarize what changed, list changed files, and report verification honestly.',
  ].join('\n');
}

function formatAppliedInstructions(workingSet: WorkingSet): readonly string[] {
  if (workingSet.appliedInstructions === undefined || workingSet.appliedInstructions.length === 0) {
    return [];
  }
  return [
    'Applied instructions for this Task boundary (follow them without changing the original Goal):',
    ...workingSet.appliedInstructions.map(
      (instruction) =>
        `- [${instruction.kind}] ${instruction.content} (revision ${instruction.appliedRevision})`,
    ),
  ];
}

function formatRetryContext(context: WorkerRetryContext | undefined): readonly string[] {
  if (context === undefined) return [];
  const evidence = JSON.stringify(context.previousVerificationEvidence).slice(0, 16_384);
  return [
    '',
    'Previous attempt context (diagnostic only; it is not new verification evidence):',
    ...(context.previousAttemptId === undefined
      ? []
      : [
          `Previous Attempt: ${context.previousAttemptId} (${context.previousAttemptStatus ?? 'unknown'})`,
        ]),
    ...(context.previousVerificationStatus === undefined
      ? []
      : [`Previous Verification: ${context.previousVerificationStatus}`]),
    ...(context.previousVerificationReason === undefined
      ? []
      : [`Previous Verification reason: ${context.previousVerificationReason}`]),
    `Repair objective: ${context.repairObjective}`,
    `Previous Verification evidence: ${evidence}`,
  ];
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
