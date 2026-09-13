import {
  redactSecretText,
  type JsonObject,
  type StoredTask,
  type WorkerUsage,
} from '@agentscope/storage';

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
  /** Normalized failure from the previous Attempt, when it was retryable. */
  readonly previousFailure?: WorkerFailure;
  readonly previousVerificationStatus?: string;
  readonly previousVerificationReason?: string;
  readonly previousVerificationEvidence: readonly JsonObject[];
  readonly repairObjective: string;
}

export const WORKER_FAILURE_CODES = [
  'provider_exit',
  'auth',
  'rate_limit',
  'network',
  'permission',
  'invalid_output',
  'user_interrupt',
  'spawn_error',
  'unknown',
] as const;

export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];

/** A normalized, safe description of why a Worker boundary did not complete. */
export interface WorkerFailure {
  readonly code: WorkerFailureCode;
  readonly retryable: boolean;
  /** Deliberately generic; raw provider diagnostics are never persisted here. */
  readonly summary: string;
  /** Stable correlation token for logs/diagnostics without retaining raw output. */
  readonly diagnosticRef: string;
  readonly exitCode?: number;
}

export interface WorkerFailureInput {
  readonly provider?: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** Transient stderr/provider error text; it is classified and discarded. */
  readonly diagnostic?: string;
  /** Safe code taken from a normalized provider error event, when available. */
  readonly errorCode?: string;
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
  readonly failure?: WorkerFailure;
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

/**
 * Classify provider/process failures without persisting provider output. The
 * order is intentional: rate-limit and network hints are checked before broad
 * authentication/permission hints because compatible endpoints sometimes use
 * 403 for temporary concurrency limits.
 */
export function classifyWorkerFailure(input: WorkerFailureInput): WorkerFailure | undefined {
  const diagnostic = `${input.errorCode ?? ''} ${input.diagnostic ?? ''}`.toLowerCase();
  const explicitCode = normalizeFailureCode(input.errorCode);
  if (
    input.status === 'completed' &&
    input.signal === undefined &&
    input.exitCode !== undefined &&
    input.exitCode !== null &&
    input.exitCode === 0
  ) {
    return undefined;
  }

  const code: WorkerFailureCode =
    input.status === 'interrupted' || input.signal !== undefined || input.exitCode === 130
      ? 'user_interrupt'
      : explicitCode !== undefined
        ? explicitCode
        : hasAny(diagnostic, [
              'rate limit',
              'ratelimit',
              'too many requests',
              'concurrent',
              'overloaded',
              'capacity',
              'http 429',
              'status 429',
            ])
          ? 'rate_limit'
          : hasAny(diagnostic, [
                'econn',
                'etimedout',
                'enotfound',
                'network',
                'socket',
                'tls',
                'unknownissuer',
                'connection refused',
                'connection reset',
                'timeout',
              ])
            ? 'network'
            : hasAny(diagnostic, [
                  'not logged in',
                  'unauthorized',
                  'authentication',
                  'api key',
                  'access token',
                  'http 401',
                  'status 401',
                ])
              ? 'auth'
              : hasAny(diagnostic, [
                    'permission denied',
                    'approval required',
                    'not allowed',
                    'forbidden',
                    'permission',
                    'http 403',
                    'status 403',
                  ])
                ? 'permission'
                : hasAny(diagnostic, [
                      'invalid json',
                      'malformed',
                      'parse error',
                      'unexpected token',
                      'invalid output',
                      'schema validation',
                    ])
                  ? 'invalid_output'
                  : hasAny(diagnostic, ['spawn_error', 'enoent', 'could not be started'])
                    ? 'spawn_error'
                    : input.status === 'failed'
                      ? 'provider_exit'
                      : 'unknown';
  const provider = safeIdentifier(input.provider ?? 'provider');
  const exitCode =
    typeof input.exitCode === 'number' && Number.isInteger(input.exitCode)
      ? input.exitCode
      : undefined;
  return {
    code,
    retryable: code === 'rate_limit' || code === 'network' || code === 'invalid_output',
    summary: `Worker ${failureLabel(code)}.`,
    diagnosticRef: `worker:${provider}:${code}:${exitCode ?? 'none'}`,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function normalizeFailureCode(value: string | undefined): WorkerFailureCode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase().replace(/-/gu, '_');
  return (WORKER_FAILURE_CODES as readonly string[]).includes(normalized)
    ? (normalized as WorkerFailureCode)
    : undefined;
}

function failureLabel(code: WorkerFailureCode): string {
  switch (code) {
    case 'provider_exit':
      return 'provider process exited before a verified completion';
    case 'auth':
      return 'provider authentication failed; human action is required';
    case 'rate_limit':
      return 'provider rate limit or concurrency limit was reached';
    case 'network':
      return 'provider network request failed';
    case 'permission':
      return 'provider permission or approval was not available';
    case 'invalid_output':
      return 'provider output was invalid or incomplete';
    case 'user_interrupt':
      return 'execution was interrupted by the user or host';
    case 'spawn_error':
      return 'provider process could not be started';
    case 'unknown':
      return 'provider execution failed for an unknown reason';
  }
}

function hasAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function safeIdentifier(value: string): string {
  const redacted = redactSecretText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-');
  return redacted.replace(/^-+|-+$/gu, '').slice(0, 40) || 'provider';
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
    ...(context.previousFailure === undefined
      ? []
      : [
          `Previous Worker failure: ${context.previousFailure.code} (retryable=${context.previousFailure.retryable})`,
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
