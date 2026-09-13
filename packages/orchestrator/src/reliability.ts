import type {
  StoredAttempt,
  StoredGoal,
  StoredOrchestratorEvent,
  StoredTask,
  StoredVerificationRun,
} from '@agentscope/storage';

export interface ReliabilityMetricsInput {
  readonly goals: readonly StoredGoal[];
  readonly tasks: readonly StoredTask[];
  readonly attempts: readonly StoredAttempt[];
  readonly verifications?: readonly StoredVerificationRun[];
  readonly events?: readonly StoredOrchestratorEvent[];
}

export interface ReliabilityRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value?: number;
}

export interface RuntimeSummary {
  readonly sampleCount: number;
  readonly averageSeconds?: number;
  readonly p50Seconds?: number;
  readonly p95Seconds?: number;
}

export interface UsageSummary {
  readonly availability: 'available' | 'partial' | 'unavailable';
  readonly reportedAttemptCount: number;
  readonly attemptCount: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly totalCostUsd?: number;
}

export interface ReliabilityMetrics {
  readonly generatedAt: number;
  readonly goalCount: number;
  readonly activeGoalCount: number;
  readonly archivedGoalCount: number;
  readonly taskCount: number;
  readonly attemptCount: number;
  readonly taskSuccessRate: ReliabilityRate;
  readonly averageRepairAttempts?: number;
  readonly humanInterventionRate: ReliabilityRate;
  readonly runtime: RuntimeSummary;
  readonly usage: UsageSummary;
  /**
   * Proxy only: a completed Goal later failing final verification or creating a
   * Gap Task. It is not a claim that an unobserved completion was incorrect.
   */
  readonly falseCompletionRateProxy: ReliabilityRate;
}

/**
 * Aggregate V1 reliability metrics from durable Goal/Task/Attempt evidence.
 *
 * Definitions are intentionally explicit: skipped Tasks are outside the success
 * denominator, human intervention is based on NEEDS_HUMAN/approval/recovery
 * evidence, and missing provider usage stays unavailable rather than zero.
 */
export function computeReliabilityMetrics(
  input: ReliabilityMetricsInput,
  generatedAt = Date.now(),
): ReliabilityMetrics {
  const goalIds = new Set(input.goals.map((goal) => goal.id));
  const tasks = input.tasks.filter((task) => goalIds.has(task.goalId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const attempts = input.attempts.filter((attempt) => taskIds.has(attempt.taskId));
  const verifications = (input.verifications ?? []).filter((verification) =>
    taskIds.has(verification.taskId),
  );
  const events = (input.events ?? []).filter((event) => goalIds.has(event.goalId));
  const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
  const unsuccessfulTerminalTasks = tasks.filter((task) =>
    ['FAILED', 'NEEDS_HUMAN'].includes(task.status),
  ).length;
  const taskSuccessDenominator = completedTasks + unsuccessfulTerminalTasks;
  const taskSuccessRate = rate(completedTasks, taskSuccessDenominator);
  const attemptedTaskIds = new Set(attempts.map((attempt) => attempt.taskId));
  const repairAttemptTotal = attempts.reduce(
    (total, attempt) => total + (attempt.attemptNumber > 1 ? 1 : 0),
    0,
  );
  const averageRepairAttempts =
    attemptedTaskIds.size === 0 ? undefined : repairAttemptTotal / attemptedTaskIds.size;
  const humanGoalIds = new Set(
    input.goals.filter((goal) => goal.status === 'NEEDS_HUMAN').map((goal) => goal.id),
  );
  for (const event of events) {
    if (
      event.type === 'goal.needs_human' ||
      event.type === 'goal.recovery.needs_human' ||
      event.type === 'goal.approval.requested' ||
      event.type === 'goal.budget.exceeded'
    ) {
      humanGoalIds.add(event.goalId);
    }
  }
  const humanInterventionRate = rate(humanGoalIds.size, input.goals.length);
  const runtime = runtimeSummary(input.goals);
  const usage = usageSummary(attempts);
  const falseCompletionGoalIds = falseCompletionGoals(input.goals, tasks, events, verifications);
  const falseCompletionRateProxy = rate(falseCompletionGoalIds.size, input.goals.length);
  return {
    generatedAt,
    goalCount: input.goals.length,
    activeGoalCount: input.goals.filter((goal) => goal.archivedAt === undefined).length,
    archivedGoalCount: input.goals.filter((goal) => goal.archivedAt !== undefined).length,
    taskCount: tasks.length,
    attemptCount: attempts.length,
    taskSuccessRate,
    ...(averageRepairAttempts === undefined ? {} : { averageRepairAttempts }),
    humanInterventionRate,
    runtime,
    usage,
    falseCompletionRateProxy,
  };
}

function rate(numerator: number, denominator: number): ReliabilityRate {
  return {
    numerator,
    denominator,
    ...(denominator === 0 ? {} : { value: numerator / denominator }),
  };
}

function runtimeSummary(goals: readonly StoredGoal[]): RuntimeSummary {
  const durations = goals
    .filter((goal) => ['COMPLETED', 'FAILED', 'ABORTED'].includes(goal.status))
    .map((goal) => Math.max(0, (goal.completedAt ?? goal.updatedAt) - goal.createdAt) / 1_000)
    .filter((duration) => Number.isFinite(duration));
  if (durations.length === 0) return { sampleCount: 0 };
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    averageSeconds: round(durations.reduce((total, value) => total + value, 0) / durations.length),
    p50Seconds: round(percentile(sorted, 0.5)),
    p95Seconds: round(percentile(sorted, 0.95)),
  };
}

function usageSummary(attempts: readonly StoredAttempt[]): UsageSummary {
  const reported = attempts.filter((attempt) => attempt.workerResult?.usage !== undefined);
  if (reported.length === 0) {
    return {
      availability: 'unavailable',
      reportedAttemptCount: 0,
      attemptCount: attempts.length,
    };
  }
  const field = (name: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cost') => {
    if (reported.some((attempt) => attempt.workerResult?.usage?.[name] === undefined)) return;
    return reported.reduce(
      (total, attempt) => total + (attempt.workerResult?.usage?.[name] ?? 0),
      0,
    );
  };
  const inputTokens = field('inputTokens');
  const outputTokens = field('outputTokens');
  const totalTokens = field('totalTokens');
  const totalCostUsd = field('cost');
  return {
    availability: reported.length === attempts.length ? 'available' : 'partial',
    reportedAttemptCount: reported.length,
    attemptCount: attempts.length,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
  };
}

function falseCompletionGoals(
  goals: readonly StoredGoal[],
  tasks: readonly StoredTask[],
  events: readonly StoredOrchestratorEvent[],
  verifications: readonly StoredVerificationRun[],
): ReadonlySet<string> {
  const completedGoalIds = new Set(
    goals.filter((goal) => goal.status === 'COMPLETED').map((goal) => goal.id),
  );
  const falseGoals = new Set<string>();
  for (const event of events) {
    if (!completedGoalIds.has(event.goalId)) continue;
    if (event.type === 'goal.gap_task.created') {
      falseGoals.add(event.goalId);
      continue;
    }
    if (event.type !== 'goal.verification.completed') continue;
    const status = event.payload.status;
    if (status === 'FAIL' || status === 'UNCERTAIN') falseGoals.add(event.goalId);
  }
  for (const verification of verifications) {
    if (verification.status !== 'FAIL' && verification.status !== 'UNCERTAIN') continue;
    const task = tasks.find((candidate) => candidate.id === verification.taskId);
    if (task !== undefined && completedGoalIds.has(task.goalId)) falseGoals.add(task.goalId);
  }
  return falseGoals;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = (values.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower] ?? 0;
  const left = values[lower] ?? 0;
  const right = values[upper] ?? left;
  return left + (right - left) * (index - lower);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
