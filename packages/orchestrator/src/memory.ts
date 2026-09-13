import type {
  CompletedTaskSummary,
  ExecutionDecision,
  ExecutionIssue,
  ExecutionMemory,
  ExecutionQuestion,
  MemorySourceRef,
} from './index.js';
import type {
  JsonObject,
  StoredGoal,
  StoredTask,
  StoredVerificationRun,
} from '@agentscope/storage';

const MAX_GOAL_SUMMARY_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_DECISIONS = 100;
const MAX_COMPLETED_TASKS = 100;
const MAX_ISSUES = 100;
const MAX_QUESTIONS = 100;
const MAX_NOTES = 200;
const MAX_FAILED_APPROACHES = 100;
const MAX_SOURCE_REFS = 300;

export interface MemorySnapshotBuildInput {
  readonly goal: Pick<StoredGoal, 'id' | 'prompt' | 'activeRevision'>;
  readonly tasks: readonly StoredTask[];
  readonly executionMemory: ExecutionMemory;
  readonly verificationRuns?: readonly StoredVerificationRun[];
  readonly reason?: string;
  readonly now: number;
}

export interface MemorySnapshotBuildResult {
  readonly memory: JsonObject;
  readonly sources: readonly JsonObject[];
}

/**
 * Build the durable, bounded memory representation used at a safe boundary.
 * Only known fields are copied and free-form text is redacted before it is
 * persisted. Raw Provider output, environment variables, and file contents
 * are intentionally not part of a memory snapshot.
 */
export function buildMemorySnapshot(input: MemorySnapshotBuildInput): MemorySnapshotBuildResult {
  const memory = normalizeExecutionMemory(input.executionMemory, input.now);
  const completedTaskSummaries = mergeCompletedTaskSummaries(
    memory.completedTaskSummaries ?? [],
    input.tasks,
    input.verificationRuns ?? [],
    input.now,
  );
  const sourceRefs = uniqueSourceRefs([
    ...(memory.sourceRefs ?? []),
    { kind: 'goal', id: input.goal.id },
    { kind: 'roadmap-revision', id: `${input.goal.id}:revision:${input.goal.activeRevision}` },
    ...memory.decisions.flatMap((decision) => decision.sourceRefs ?? []),
    ...completedTaskSummaries.flatMap((summary) => summary.sourceRefs),
  ]).slice(-MAX_SOURCE_REFS);
  const snapshotMemory: JsonObject = {
    schemaVersion: 1,
    goalSummary: redactText(memory.goalSummary ?? input.goal.prompt, MAX_GOAL_SUMMARY_LENGTH),
    decisions: memory.decisions,
    completedTaskIds: memory.completedTaskIds,
    completedTaskSummaries,
    failedApproaches: memory.failedApproaches,
    issues: memory.issues ?? [],
    questions: memory.questions ?? [],
    notes: memory.notes,
    sourceRefs,
    activeRevision: input.goal.activeRevision,
    updatedAt: input.now,
    ...(input.reason === undefined
      ? {}
      : { snapshotReason: redactText(input.reason, MAX_TEXT_LENGTH) }),
  };
  return {
    memory: snapshotMemory,
    sources: sourceRefs.map((source) => ({ ...source })),
  };
}

/** Normalize persisted/user-provided memory without allowing unknown data to grow unbounded. */
export function normalizeExecutionMemory(memory: ExecutionMemory, now: number): ExecutionMemory {
  const decisions = normalizeDecisions(memory.decisions).slice(-MAX_DECISIONS);
  const completedTaskIds = uniqueStrings(memory.completedTaskIds).slice(-MAX_COMPLETED_TASKS);
  const completedTaskSummaries = normalizeCompletedTaskSummaries(
    memory.completedTaskSummaries ?? [],
  ).slice(-MAX_COMPLETED_TASKS);
  const failedApproaches = uniqueStrings(memory.failedApproaches, MAX_TEXT_LENGTH).slice(
    -MAX_FAILED_APPROACHES,
  );
  const issues = normalizeIssues(memory.issues ?? []).slice(-MAX_ISSUES);
  const questions = normalizeQuestions(memory.questions ?? []).slice(-MAX_QUESTIONS);
  const notes = uniqueStrings(memory.notes, MAX_TEXT_LENGTH).slice(-MAX_NOTES);
  const sourceRefs = uniqueSourceRefs(memory.sourceRefs ?? []).slice(-MAX_SOURCE_REFS);
  return {
    ...(memory.goalSummary === undefined
      ? {}
      : { goalSummary: redactText(memory.goalSummary, MAX_GOAL_SUMMARY_LENGTH) }),
    decisions,
    completedTaskIds,
    ...(completedTaskSummaries.length === 0 ? {} : { completedTaskSummaries }),
    failedApproaches,
    ...(issues.length === 0 ? {} : { issues }),
    ...(questions.length === 0 ? {} : { questions }),
    notes,
    ...(sourceRefs.length === 0 ? {} : { sourceRefs }),
    ...(memory.updatedAt === undefined ? { updatedAt: now } : { updatedAt: memory.updatedAt }),
  };
}

/** Record a verified task outcome while preserving prior memory fields. */
export function rememberTaskOutcome(
  memory: ExecutionMemory,
  task: StoredTask,
  verification: StoredVerificationRun | undefined,
  summary: string,
  recordedAt: number,
): ExecutionMemory {
  const normalized = normalizeExecutionMemory(memory, recordedAt);
  const taskRef: MemorySourceRef = { kind: 'task', id: task.id };
  const sourceRefs = [
    taskRef,
    ...(verification === undefined ? [] : [{ kind: 'verification' as const, id: verification.id }]),
  ];
  const nextSummary: CompletedTaskSummary = {
    taskId: task.id,
    title: redactText(task.title, MAX_TEXT_LENGTH),
    summary: redactText(summary, MAX_TEXT_LENGTH),
    ...(verification === undefined ? {} : { verificationStatus: verification.status }),
    recordedAt,
    sourceRefs,
  };
  const summaries = [
    ...(normalized.completedTaskSummaries ?? []).filter((item) => item.taskId !== task.id),
    ...(task.status === 'COMPLETED' ? [nextSummary] : []),
  ].slice(-MAX_COMPLETED_TASKS);
  const completedTaskIds =
    task.status === 'COMPLETED'
      ? uniqueStrings([...normalized.completedTaskIds, task.id]).slice(-MAX_COMPLETED_TASKS)
      : normalized.completedTaskIds;
  const nextSourceRefs = uniqueSourceRefs([...(normalized.sourceRefs ?? []), ...sourceRefs]);
  return {
    ...normalized,
    completedTaskIds,
    ...(summaries.length === 0 ? {} : { completedTaskSummaries: summaries }),
    sourceRefs: nextSourceRefs.slice(-MAX_SOURCE_REFS),
    updatedAt: recordedAt,
  };
}

function mergeCompletedTaskSummaries(
  existing: readonly CompletedTaskSummary[],
  tasks: readonly StoredTask[],
  verificationRuns: readonly StoredVerificationRun[],
  now: number,
): readonly CompletedTaskSummary[] {
  const byTask = new Map(existing.map((summary) => [summary.taskId, summary]));
  for (const task of tasks) {
    if (task.status !== 'COMPLETED') continue;
    const verification = [...verificationRuns]
      .filter((run) => run.taskId === task.id)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (byTask.has(task.id)) continue;
    byTask.set(task.id, {
      taskId: task.id,
      title: redactText(task.title, MAX_TEXT_LENGTH),
      summary: verification?.reason
        ? redactText(verification.reason, MAX_TEXT_LENGTH)
        : 'Task completed; verification details are recorded separately.',
      ...(verification === undefined ? {} : { verificationStatus: verification.status }),
      recordedAt: task.endedAt ?? task.updatedAt ?? now,
      sourceRefs: [
        { kind: 'task', id: task.id },
        ...(verification === undefined
          ? []
          : [{ kind: 'verification' as const, id: verification.id }]),
      ],
    });
  }
  return [...byTask.values()].slice(-MAX_COMPLETED_TASKS);
}

function normalizeDecisions(value: readonly ExecutionDecision[]): readonly ExecutionDecision[] {
  return value.flatMap((decision) => {
    if (!isRecord(decision)) return [];
    if (
      typeof decision.id !== 'string' ||
      typeof decision.summary !== 'string' ||
      !isDecisionStatus(decision.status) ||
      !isDecisionSource(decision.source) ||
      typeof decision.recordedAt !== 'number'
    ) {
      return [];
    }
    const sourceRefs = normalizeSourceRefs(decision.sourceRefs ?? []);
    return [
      {
        id: redactText(decision.id, 300),
        summary: redactText(decision.summary, MAX_TEXT_LENGTH),
        status: decision.status,
        source: decision.source,
        recordedAt: decision.recordedAt,
        ...(sourceRefs.length === 0 ? {} : { sourceRefs }),
      },
    ];
  });
}

function normalizeCompletedTaskSummaries(
  values: readonly CompletedTaskSummary[],
): readonly CompletedTaskSummary[] {
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (
      typeof value.taskId !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.summary !== 'string' ||
      typeof value.recordedAt !== 'number'
    ) {
      return [];
    }
    const sourceRefs = normalizeSourceRefs(value.sourceRefs ?? []);
    return [
      {
        taskId: redactText(value.taskId, 300),
        title: redactText(value.title, MAX_TEXT_LENGTH),
        summary: redactText(value.summary, MAX_TEXT_LENGTH),
        ...(isVerificationStatus(value.verificationStatus)
          ? { verificationStatus: value.verificationStatus }
          : {}),
        recordedAt: value.recordedAt,
        sourceRefs,
      },
    ];
  });
}

function normalizeIssues(values: readonly ExecutionIssue[]): readonly ExecutionIssue[] {
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (
      typeof value.id !== 'string' ||
      typeof value.summary !== 'string' ||
      !isIssueStatus(value.status) ||
      typeof value.recordedAt !== 'number'
    ) {
      return [];
    }
    return [
      {
        id: redactText(value.id, 300),
        summary: redactText(value.summary, MAX_TEXT_LENGTH),
        status: value.status,
        recordedAt: value.recordedAt,
        sourceRefs: normalizeSourceRefs(value.sourceRefs ?? []),
      },
    ];
  });
}

function normalizeQuestions(values: readonly ExecutionQuestion[]): readonly ExecutionQuestion[] {
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (
      typeof value.id !== 'string' ||
      typeof value.question !== 'string' ||
      !isQuestionStatus(value.status) ||
      typeof value.recordedAt !== 'number'
    ) {
      return [];
    }
    return [
      {
        id: redactText(value.id, 300),
        question: redactText(value.question, MAX_TEXT_LENGTH),
        status: value.status,
        recordedAt: value.recordedAt,
        sourceRefs: normalizeSourceRefs(value.sourceRefs ?? []),
      },
    ];
  });
}

function normalizeSourceRefs(values: readonly unknown[]): readonly MemorySourceRef[] {
  return uniqueSourceRefs(
    values.flatMap((value) => {
      if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.id !== 'string') {
        return [];
      }
      if (!isSourceKind(value.kind)) return [];
      return [
        {
          kind: value.kind,
          id: redactText(value.id, 300),
          ...(typeof value.summary === 'string'
            ? { summary: redactText(value.summary, MAX_TEXT_LENGTH) }
            : {}),
        },
      ];
    }),
  );
}

function uniqueSourceRefs(values: readonly MemorySourceRef[]): readonly MemorySourceRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.kind}:${value.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: readonly string[], maxLength = 300): readonly string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const normalized = redactText(value, maxLength);
    if (normalized.length === 0 || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function redactText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_SECRET]')
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s,"']+/giu,
      '$1$2[REDACTED_SECRET]',
    )
    .trim();
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDecisionStatus(value: unknown): value is ExecutionDecision['status'] {
  return value === 'LOCKED' || value === 'STABLE' || value === 'TENTATIVE';
}

function isDecisionSource(value: unknown): value is ExecutionDecision['source'] {
  return value === 'user' || value === 'planner' || value === 'verifier' || value === 'system';
}

function isVerificationStatus(
  value: unknown,
): value is NonNullable<CompletedTaskSummary['verificationStatus']> {
  return value === 'PASS' || value === 'FAIL' || value === 'UNCERTAIN';
}

function isIssueStatus(value: unknown): value is ExecutionIssue['status'] {
  return value === 'OPEN' || value === 'RESOLVED';
}

function isQuestionStatus(value: unknown): value is ExecutionQuestion['status'] {
  return value === 'OPEN' || value === 'ANSWERED';
}

function isSourceKind(value: string): value is MemorySourceRef['kind'] {
  return (
    value === 'goal' ||
    value === 'instruction' ||
    value === 'task' ||
    value === 'attempt' ||
    value === 'verification' ||
    value === 'evidence' ||
    value === 'event' ||
    value === 'project-state' ||
    value === 'roadmap-revision'
  );
}
