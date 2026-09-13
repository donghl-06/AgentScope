import type { JsonObject } from '@agentscope/storage';

export const BUDGET_STATUSES = ['OK', 'WARNING', 'EXCEEDED'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

export const BUDGET_METRICS = [
  'goal-attempts',
  'task-attempts',
  'wall-clock',
  'tokens',
  'cost',
] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export interface BudgetPolicy {
  readonly maxGoalAttempts?: number;
  readonly maxTaskAttempts?: number;
  readonly warningWallClockMs?: number;
  readonly maxWallClockMs?: number;
  readonly warningTokens?: number;
  readonly maxTokens?: number;
  readonly warningCost?: number;
  readonly maxCost?: number;
}

export interface BudgetConfigurationIssue {
  readonly key: string;
  readonly value: unknown;
  readonly reason: string;
}

export interface BudgetPolicyResult {
  readonly policy: BudgetPolicy;
  readonly issues: readonly BudgetConfigurationIssue[];
}

export interface BudgetUsage {
  readonly goalAttempts: number;
  readonly taskAttempts: number;
  readonly elapsedMs: number;
  readonly totalTokens?: number;
  readonly cost?: number;
}

export interface BudgetSignal {
  readonly metric: BudgetMetric;
  readonly severity: 'warning' | 'exceeded';
  readonly limit: number;
  readonly observed: number;
  readonly scope: 'goal' | 'task';
  readonly code: string;
  readonly message: string;
}

export interface BudgetEvaluation {
  readonly status: BudgetStatus;
  readonly policy: BudgetPolicy;
  readonly usage: BudgetUsage;
  readonly signals: readonly BudgetSignal[];
  readonly unavailable: readonly BudgetMetric[];
  readonly issues: readonly BudgetConfigurationIssue[];
  readonly reasons: readonly string[];
}

/**
 * Resolve the strictest usable limits from Goal and Task constraints.
 *
 * Constraints are intentionally additive: a Task can narrow a Goal budget,
 * but cannot widen it. Invalid optional values are reported to the caller and
 * ignored so existing V0 constraints remain backwards compatible.
 */
export function resolveBudgetPolicy(input: {
  readonly goalConstraints?: JsonObject;
  readonly taskConstraints?: JsonObject;
  readonly taskMaxAttempts?: number;
}): BudgetPolicyResult {
  const issues: BudgetConfigurationIssue[] = [];
  const goal = input.goalConstraints ?? {};
  const task = input.taskConstraints ?? {};
  const maxGoalAttempts = readLimit(goal, 'maxAttempts', 'goal', issues);
  const configuredTaskAttempts = readLimit(task, 'maxAttempts', 'task', issues);
  const taskMaxAttempts = strictestLimit(
    'maxTaskAttempts',
    [configuredTaskAttempts, input.taskMaxAttempts],
    issues,
  );
  const maxWallClockMs = strictestLimit(
    'maxWallClockMs',
    [
      readLimit(goal, 'maxWallClockMs', 'goal', issues),
      readLimit(task, 'maxWallClockMs', 'task', issues),
    ],
    issues,
  );
  const warningWallClockMs = strictestWarning(
    'warningWallClockMs',
    [
      readLimit(goal, 'warningWallClockMs', 'goal', issues),
      readLimit(task, 'warningWallClockMs', 'task', issues),
    ],
    maxWallClockMs,
    issues,
  );
  const maxTokens = strictestLimit(
    'maxTokens',
    [readLimit(goal, 'maxTokens', 'goal', issues), readLimit(task, 'maxTokens', 'task', issues)],
    issues,
  );
  const warningTokens = strictestWarning(
    'warningTokens',
    [
      readLimit(goal, 'warningTokens', 'goal', issues),
      readLimit(task, 'warningTokens', 'task', issues),
    ],
    maxTokens,
    issues,
  );
  const maxCost = strictestLimit(
    'maxCost',
    [readLimit(goal, 'maxCost', 'goal', issues), readLimit(task, 'maxCost', 'task', issues)],
    issues,
  );
  const warningCost = strictestWarning(
    'warningCost',
    [
      readLimit(goal, 'warningCost', 'goal', issues),
      readLimit(task, 'warningCost', 'task', issues),
    ],
    maxCost,
    issues,
  );
  return {
    policy: {
      ...(maxGoalAttempts === undefined ? {} : { maxGoalAttempts }),
      ...(taskMaxAttempts === undefined ? {} : { maxTaskAttempts: taskMaxAttempts }),
      ...(warningWallClockMs === undefined ? {} : { warningWallClockMs }),
      ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
      ...(warningTokens === undefined ? {} : { warningTokens }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(warningCost === undefined ? {} : { warningCost }),
      ...(maxCost === undefined ? {} : { maxCost }),
    },
    issues,
  };
}

/** Evaluate only observed usage; missing provider usage is never inferred. */
export function evaluateBudget(input: {
  readonly goalConstraints?: JsonObject;
  readonly taskConstraints?: JsonObject;
  readonly taskMaxAttempts?: number;
  readonly usage: BudgetUsage;
}): BudgetEvaluation {
  const resolved = resolveBudgetPolicy(input);
  const signals: BudgetSignal[] = [];
  const unavailable: BudgetMetric[] = [];
  checkObservedLimit(
    signals,
    'goal-attempts',
    'goal',
    input.usage.goalAttempts,
    resolved.policy.maxGoalAttempts,
    undefined,
  );
  checkObservedLimit(
    signals,
    'task-attempts',
    'task',
    input.usage.taskAttempts,
    resolved.policy.maxTaskAttempts,
    undefined,
  );
  checkObservedLimit(
    signals,
    'wall-clock',
    'goal',
    input.usage.elapsedMs,
    resolved.policy.maxWallClockMs,
    resolved.policy.warningWallClockMs,
  );
  checkUsageLimit(
    signals,
    unavailable,
    'tokens',
    'goal',
    input.usage.totalTokens,
    resolved.policy.maxTokens,
    resolved.policy.warningTokens,
  );
  checkUsageLimit(
    signals,
    unavailable,
    'cost',
    'goal',
    input.usage.cost,
    resolved.policy.maxCost,
    resolved.policy.warningCost,
  );
  const exceeded = signals.some((signal) => signal.severity === 'exceeded');
  const warning = signals.some((signal) => signal.severity === 'warning');
  const status: BudgetStatus = exceeded
    ? 'EXCEEDED'
    : warning || resolved.issues.length > 0
      ? 'WARNING'
      : 'OK';
  const reasons = [
    ...resolved.issues.map((issue) => `Invalid budget ${issue.key}: ${issue.reason}`),
    ...signals.map((signal) => signal.message),
    ...unavailable.map(
      (metric) => `Provider ${metric} usage is unavailable; no limit decision was inferred.`,
    ),
  ];
  if (reasons.length === 0) reasons.push('No configured budget has been reached.');
  return {
    status,
    policy: resolved.policy,
    usage: input.usage,
    signals,
    unavailable,
    issues: resolved.issues,
    reasons,
  };
}

function readLimit(
  constraints: JsonObject,
  key: string,
  scope: string,
  issues: BudgetConfigurationIssue[],
): number | undefined {
  const value = constraints[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issues.push({
      key: `${scope}.${key}`,
      value,
      reason: 'must be a finite number greater than zero',
    });
    return undefined;
  }
  return value;
}

function strictestLimit(
  key: string,
  values: readonly (number | undefined)[],
  issues: BudgetConfigurationIssue[],
): number | undefined {
  const usable = values.filter((value): value is number => value !== undefined);
  if (usable.length === 0) return undefined;
  const result = Math.min(...usable);
  if (!Number.isFinite(result) || result <= 0) {
    issues.push({ key, value: values, reason: 'resolved limit is not usable' });
    return undefined;
  }
  return result;
}

function strictestWarning(
  key: string,
  values: readonly (number | undefined)[],
  hardLimit: number | undefined,
  issues: BudgetConfigurationIssue[],
): number | undefined {
  const warning = strictestLimit(key, values, issues);
  if (warning === undefined || hardLimit === undefined) return warning;
  if (warning >= hardLimit) {
    issues.push({ key, value: warning, reason: `must be lower than hard limit ${hardLimit}` });
    return undefined;
  }
  return warning;
}

function checkObservedLimit(
  signals: BudgetSignal[],
  metric: BudgetMetric,
  scope: 'goal' | 'task',
  observed: number,
  hardLimit: number | undefined,
  warningLimit: number | undefined,
): void {
  if (hardLimit !== undefined && observed >= hardLimit) {
    signals.push(createSignal(metric, 'exceeded', hardLimit, observed, scope));
  } else if (warningLimit !== undefined && observed >= warningLimit) {
    signals.push(createSignal(metric, 'warning', warningLimit, observed, scope));
  }
}

function checkUsageLimit(
  signals: BudgetSignal[],
  unavailable: BudgetMetric[],
  metric: BudgetMetric,
  scope: 'goal' | 'task',
  observed: number | undefined,
  hardLimit: number | undefined,
  warningLimit: number | undefined,
): void {
  if (hardLimit === undefined && warningLimit === undefined) return;
  if (observed === undefined || !Number.isFinite(observed) || observed < 0) {
    unavailable.push(metric);
    return;
  }
  checkObservedLimit(signals, metric, scope, observed, hardLimit, warningLimit);
}

function createSignal(
  metric: BudgetMetric,
  severity: 'warning' | 'exceeded',
  limit: number,
  observed: number,
  scope: 'goal' | 'task',
): BudgetSignal {
  const unit =
    metric === 'wall-clock'
      ? 'ms'
      : metric === 'tokens'
        ? 'tokens'
        : metric === 'cost'
          ? 'cost units'
          : 'attempts';
  const verb = severity === 'exceeded' ? 'exceeded' : 'reached warning threshold for';
  return {
    metric,
    severity,
    limit,
    observed,
    scope,
    code: `${metric.replaceAll('-', '_')}_${severity}`,
    message: `${scope} ${metric} ${verb} ${limit} ${unit} (observed ${observed}).`,
  };
}
