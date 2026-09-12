import type Database from 'better-sqlite3';

import { StorageCorruptPayloadError, StorageError, StorageNotFoundError } from './repository.js';

export const GOAL_STATUSES = [
  'CREATED',
  'PLANNING',
  'RUNNING',
  'VERIFYING',
  'PAUSED',
  'NEEDS_HUMAN',
  'COMPLETED',
  'FAILED',
  'ABORTED',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'VERIFYING',
  'REPAIRING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'NEEDS_HUMAN',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  'CREATED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'NEEDS_HUMAN',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const VERIFICATION_STATUSES = ['PASS', 'FAIL', 'UNCERTAIN'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface JsonObject {
  readonly [key: string]: unknown;
}

export interface RoadmapItem {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly status: 'LOCKED' | 'TENTATIVE' | 'COMPLETED' | 'SKIPPED';
}

export interface WorkerResult {
  readonly claimedStatus: 'completed' | 'blocked' | 'failed';
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly reportedVerification: JsonObject;
}

export interface VerificationCheck {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

export interface StoredGoal {
  readonly id: string;
  readonly workspace: string;
  readonly prompt: string;
  readonly provider: string;
  readonly status: GoalStatus;
  readonly constraints: JsonObject;
  readonly roadmap: readonly RoadmapItem[];
  readonly projectState: JsonObject;
  readonly executionMemory: JsonObject;
  readonly workingSet: JsonObject;
  readonly currentTaskId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface StoredTask {
  readonly id: string;
  readonly goalId: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verification: JsonObject;
  readonly constraints: JsonObject;
  readonly maxAttempts: number;
  readonly status: TaskStatus;
  readonly sequence: number;
  readonly tentative: boolean;
  readonly parentTaskId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface StoredAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly sessionId?: string;
  readonly status: AttemptStatus;
  readonly workerResult?: WorkerResult;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface StoredVerificationRun {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly status: VerificationStatus;
  readonly criteria: readonly string[];
  readonly deterministicChecks: readonly JsonObject[];
  readonly evidence: readonly JsonObject[];
  readonly reason: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredOrchestratorEvent {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly type: string;
  readonly payload: JsonObject;
  readonly confidence: number;
}

export interface CreateGoalInput {
  readonly id: string;
  readonly workspace: string;
  readonly prompt: string;
  readonly provider: string;
  readonly constraints?: JsonObject;
  readonly roadmap?: readonly RoadmapItem[];
  readonly projectState?: JsonObject;
  readonly executionMemory?: JsonObject;
  readonly workingSet?: JsonObject;
  readonly now?: number;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly goalId: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verification?: JsonObject;
  readonly constraints?: JsonObject;
  readonly maxAttempts?: number;
  readonly sequence: number;
  readonly tentative?: boolean;
  readonly parentTaskId?: string;
  readonly now?: number;
}

export interface CreateAttemptInput {
  readonly id: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly sessionId?: string;
  readonly now?: number;
}

export interface CreateVerificationRunInput {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly status: VerificationStatus;
  readonly criteria: readonly string[];
  readonly deterministicChecks: readonly JsonObject[];
  readonly evidence: readonly JsonObject[];
  readonly reason: string;
  readonly now?: number;
}

export interface AppendOrchestratorEventInput {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly timestamp?: number;
  readonly type: string;
  readonly payload?: JsonObject;
  readonly confidence: number;
}

export type OrchestratorRepositoryNotification =
  | { readonly type: 'goal.created' | 'goal.updated'; readonly goal: StoredGoal }
  | { readonly type: 'task.created' | 'task.updated'; readonly task: StoredTask }
  | { readonly type: 'attempt.created' | 'attempt.updated'; readonly attempt: StoredAttempt }
  | { readonly type: 'verification.created'; readonly verification: StoredVerificationRun }
  | { readonly type: 'event.appended'; readonly event: StoredOrchestratorEvent };

export class OrchestratorStateError extends StorageError {
  constructor(message: string) {
    super(message, 'invalid_orchestrator_state');
    this.name = 'OrchestratorStateError';
  }
}

export function assertGoalStatus(value: string): asserts value is GoalStatus {
  if (!(GOAL_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown Goal status: ${value}`);
  }
}

export function assertTaskStatus(value: string): asserts value is TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown Task status: ${value}`);
  }
}

export function assertAttemptStatus(value: string): asserts value is AttemptStatus {
  if (!(ATTEMPT_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown Attempt status: ${value}`);
  }
}

export function assertVerificationStatus(value: string): asserts value is VerificationStatus {
  if (!(VERIFICATION_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown verification status: ${value}`);
  }
}

const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  CREATED: ['PLANNING', 'PAUSED', 'ABORTED'],
  PLANNING: ['RUNNING', 'PAUSED', 'NEEDS_HUMAN', 'ABORTED'],
  RUNNING: ['VERIFYING', 'PAUSED', 'NEEDS_HUMAN', 'FAILED', 'ABORTED'],
  VERIFYING: ['RUNNING', 'COMPLETED', 'FAILED', 'NEEDS_HUMAN', 'PAUSED', 'ABORTED'],
  PAUSED: ['PLANNING', 'RUNNING', 'ABORTED'],
  NEEDS_HUMAN: ['PLANNING', 'RUNNING', 'ABORTED'],
  COMPLETED: [],
  FAILED: [],
  ABORTED: [],
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PENDING: ['RUNNING', 'SKIPPED', 'NEEDS_HUMAN'],
  RUNNING: ['VERIFYING', 'REPAIRING', 'FAILED', 'NEEDS_HUMAN', 'SKIPPED'],
  VERIFYING: ['COMPLETED', 'REPAIRING', 'FAILED', 'NEEDS_HUMAN'],
  REPAIRING: ['RUNNING', 'VERIFYING', 'FAILED', 'NEEDS_HUMAN'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED: [],
  NEEDS_HUMAN: ['RUNNING', 'SKIPPED'],
};

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (from === to) return;
  if (!GOAL_TRANSITIONS[from].includes(to)) {
    throw new OrchestratorStateError(`Invalid Goal transition: ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new OrchestratorStateError(`Invalid Task transition: ${from} -> ${to}`);
  }
}

export class OrchestratorRepository {
  private readonly listeners = new Set<
    (notification: OrchestratorRepositoryNotification) => void
  >();

  constructor(private readonly client: Database.Database) {}

  subscribe(listener: (notification: OrchestratorRepositoryNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createGoal(input: CreateGoalInput): StoredGoal {
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO goals
          (id, workspace, prompt, provider, status, constraints_json, roadmap_json,
           project_state_json, execution_memory_json, working_set_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspace,
        input.prompt,
        input.provider,
        stringifyJson(input.constraints ?? {}),
        stringifyJson(input.roadmap ?? []),
        stringifyJson(input.projectState ?? {}),
        stringifyJson(input.executionMemory ?? {}),
        stringifyJson(input.workingSet ?? {}),
        now,
        now,
      );
    const goal = this.getGoal(input.id);
    this.notify({ type: 'goal.created', goal });
    return goal;
  }

  getGoal(id: string): StoredGoal {
    const row = this.client.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
      GoalRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Goal not found: ${id}`);
    return decodeGoal(row);
  }

  listGoals(limit = 100): readonly StoredGoal[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new StorageError('Goal limit must be a positive integer.', 'invalid_query');
    }
    const rows = this.client
      .prepare('SELECT * FROM goals ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(Math.min(limit, 100)) as GoalRow[];
    return rows.map(decodeGoal);
  }

  transitionGoal(id: string, status: GoalStatus, now = Date.now()): StoredGoal {
    assertGoalStatus(status);
    const existing = this.getGoal(id);
    assertGoalTransition(existing.status, status);
    const completedAt = status === 'COMPLETED' ? now : existing.completedAt;
    this.client
      .prepare('UPDATE goals SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?')
      .run(status, now, completedAt ?? null, id);
    const goal = this.getGoal(id);
    this.notify({ type: 'goal.updated', goal });
    return goal;
  }

  updateGoalDocuments(
    id: string,
    documents: Partial<
      Pick<
        StoredGoal,
        'constraints' | 'roadmap' | 'projectState' | 'executionMemory' | 'workingSet'
      >
    > & { readonly currentTaskId?: string | null },
    now = Date.now(),
  ): StoredGoal {
    const existing = this.getGoal(id);
    this.client
      .prepare(
        `UPDATE goals SET constraints_json = ?, roadmap_json = ?, project_state_json = ?,
         execution_memory_json = ?, working_set_json = ?, current_task_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        stringifyJson(documents.constraints ?? existing.constraints),
        stringifyJson(documents.roadmap ?? existing.roadmap),
        stringifyJson(documents.projectState ?? existing.projectState),
        stringifyJson(documents.executionMemory ?? existing.executionMemory),
        stringifyJson(documents.workingSet ?? existing.workingSet),
        documents.currentTaskId === undefined
          ? (existing.currentTaskId ?? null)
          : (documents.currentTaskId ?? null),
        now,
        id,
      );
    const goal = this.getGoal(id);
    this.notify({ type: 'goal.updated', goal });
    return goal;
  }

  createTask(input: CreateTaskInput): StoredTask {
    this.getGoal(input.goalId);
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO tasks
          (id, goal_id, title, objective, acceptance_criteria_json, verification_json,
           constraints_json, max_attempts, status, sequence, tentative, parent_task_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.goalId,
        input.title,
        input.objective,
        stringifyJson(input.acceptanceCriteria),
        stringifyJson(input.verification ?? {}),
        stringifyJson(input.constraints ?? {}),
        input.maxAttempts ?? 3,
        input.sequence,
        input.tentative === true ? 1 : 0,
        input.parentTaskId ?? null,
        now,
        now,
      );
    const task = this.getTask(input.id);
    this.notify({ type: 'task.created', task });
    return task;
  }

  getTask(id: string): StoredTask {
    const row = this.client.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      TaskRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Task not found: ${id}`);
    return decodeTask(row);
  }

  listTasks(goalId: string): readonly StoredTask[] {
    this.getGoal(goalId);
    const rows = this.client
      .prepare('SELECT * FROM tasks WHERE goal_id = ? ORDER BY sequence ASC, id ASC')
      .all(goalId) as TaskRow[];
    return rows.map(decodeTask);
  }

  transitionTask(id: string, status: TaskStatus, now = Date.now()): StoredTask {
    assertTaskStatus(status);
    const existing = this.getTask(id);
    assertTaskTransition(existing.status, status);
    const startedAt =
      status === 'RUNNING' && existing.startedAt === undefined ? now : existing.startedAt;
    const endedAt = ['COMPLETED', 'FAILED', 'SKIPPED', 'NEEDS_HUMAN'].includes(status)
      ? now
      : existing.endedAt;
    this.client
      .prepare(
        'UPDATE tasks SET status = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, startedAt ?? null, endedAt ?? null, now, id);
    const task = this.getTask(id);
    this.notify({ type: 'task.updated', task });
    return task;
  }

  createAttempt(input: CreateAttemptInput): StoredAttempt {
    this.getTask(input.taskId);
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO task_attempts
          (id, task_id, attempt_number, provider, session_id, status, created_at, updated_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.taskId,
        input.attemptNumber,
        input.provider,
        input.sessionId ?? null,
        now,
        now,
      );
    const attempt = this.getAttempt(input.id);
    this.notify({ type: 'attempt.created', attempt });
    return attempt;
  }

  getAttempt(id: string): StoredAttempt {
    const row = this.client.prepare('SELECT * FROM task_attempts WHERE id = ?').get(id) as
      AttemptRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Attempt not found: ${id}`);
    return decodeAttempt(row);
  }

  listAttempts(taskId: string): readonly StoredAttempt[] {
    this.getTask(taskId);
    const rows = this.client
      .prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC')
      .all(taskId) as AttemptRow[];
    return rows.map(decodeAttempt);
  }

  updateAttempt(
    id: string,
    patch: {
      readonly status?: AttemptStatus;
      readonly sessionId?: string | null;
      readonly workerResult?: WorkerResult;
    },
    now = Date.now(),
  ): StoredAttempt {
    const existing = this.getAttempt(id);
    const status = patch.status ?? existing.status;
    assertAttemptStatus(status);
    assertAttemptTransition(existing.status, status);
    const startedAt =
      status === 'RUNNING' && existing.startedAt === undefined ? now : existing.startedAt;
    const endedAt = ['COMPLETED', 'FAILED', 'INTERRUPTED', 'NEEDS_HUMAN'].includes(status)
      ? now
      : existing.endedAt;
    this.client
      .prepare(
        `UPDATE task_attempts SET session_id = ?, status = ?, worker_result_json = ?,
         updated_at = ?, started_at = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        patch.sessionId === undefined ? (existing.sessionId ?? null) : (patch.sessionId ?? null),
        status,
        patch.workerResult === undefined
          ? existing.workerResult === undefined
            ? null
            : stringifyJson(existing.workerResult)
          : stringifyJson(patch.workerResult),
        now,
        startedAt ?? null,
        endedAt ?? null,
        id,
      );
    const attempt = this.getAttempt(id);
    this.notify({ type: 'attempt.updated', attempt });
    return attempt;
  }

  createVerificationRun(input: CreateVerificationRunInput): StoredVerificationRun {
    this.getTask(input.taskId);
    if (input.attemptId !== undefined) this.getAttempt(input.attemptId);
    assertVerificationStatus(input.status);
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO verification_runs
          (id, task_id, attempt_id, status, criteria_json, deterministic_checks_json,
           evidence_json, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.taskId,
        input.attemptId ?? null,
        input.status,
        stringifyJson(input.criteria),
        stringifyJson(input.deterministicChecks),
        stringifyJson(input.evidence),
        input.reason,
        now,
        now,
      );
    const verification = this.getVerificationRun(input.id);
    this.notify({ type: 'verification.created', verification });
    return verification;
  }

  getVerificationRun(id: string): StoredVerificationRun {
    const row = this.client.prepare('SELECT * FROM verification_runs WHERE id = ?').get(id) as
      VerificationRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Verification run not found: ${id}`);
    return decodeVerification(row);
  }

  listVerificationRuns(taskId: string): readonly StoredVerificationRun[] {
    this.getTask(taskId);
    const rows = this.client
      .prepare('SELECT * FROM verification_runs WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as VerificationRow[];
    return rows.map(decodeVerification);
  }

  appendEvent(input: AppendOrchestratorEventInput): StoredOrchestratorEvent {
    this.getGoal(input.goalId);
    if (input.taskId !== undefined) this.getTask(input.taskId);
    if (input.attemptId !== undefined) this.getAttempt(input.attemptId);
    const now = input.timestamp ?? Date.now();
    const nextSeq = (
      this.client
        .prepare(
          'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM orchestrator_events WHERE goal_id = ?',
        )
        .get(input.goalId) as { seq: number }
    ).seq;
    this.client
      .prepare(
        `INSERT INTO orchestrator_events
          (id, goal_id, task_id, attempt_id, seq, timestamp, type, payload_json, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.goalId,
        input.taskId ?? null,
        input.attemptId ?? null,
        nextSeq,
        now,
        input.type,
        stringifyJson(input.payload ?? {}),
        input.confidence,
      );
    const event = this.getEvent(input.id);
    this.notify({ type: 'event.appended', event });
    return event;
  }

  listEvents(goalId: string, afterSeq = 0, limit = 100): readonly StoredOrchestratorEvent[] {
    this.getGoal(goalId);
    if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1) {
      throw new StorageError('Invalid orchestrator event page.', 'invalid_query');
    }
    const rows = this.client
      .prepare(
        'SELECT * FROM orchestrator_events WHERE goal_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      )
      .all(goalId, afterSeq, Math.min(limit, 500)) as EventRow[];
    return rows.map(decodeEvent);
  }

  private getEvent(id: string): StoredOrchestratorEvent {
    const row = this.client.prepare('SELECT * FROM orchestrator_events WHERE id = ?').get(id) as
      EventRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Orchestrator event not found: ${id}`);
    return decodeEvent(row);
  }

  private notify(notification: OrchestratorRepositoryNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  CREATED: ['RUNNING', 'INTERRUPTED', 'FAILED', 'NEEDS_HUMAN'],
  RUNNING: ['COMPLETED', 'FAILED', 'INTERRUPTED', 'NEEDS_HUMAN'],
  COMPLETED: [],
  FAILED: [],
  INTERRUPTED: ['RUNNING', 'NEEDS_HUMAN'],
  NEEDS_HUMAN: ['RUNNING', 'INTERRUPTED'],
};

function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (from === to) return;
  if (!ATTEMPT_TRANSITIONS[from].includes(to)) {
    throw new OrchestratorStateError(`Invalid Attempt transition: ${from} -> ${to}`);
  }
}

interface GoalRow {
  id: string;
  workspace: string;
  prompt: string;
  provider: string;
  status: string;
  constraints_json: string;
  roadmap_json: string;
  project_state_json: string;
  execution_memory_json: string;
  working_set_json: string;
  current_task_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface TaskRow {
  id: string;
  goal_id: string;
  title: string;
  objective: string;
  acceptance_criteria_json: string;
  verification_json: string;
  constraints_json: string;
  max_attempts: number;
  status: string;
  sequence: number;
  tentative: number;
  parent_task_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface AttemptRow {
  id: string;
  task_id: string;
  attempt_number: number;
  provider: string;
  session_id: string | null;
  status: string;
  worker_result_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface VerificationRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  status: string;
  criteria_json: string;
  deterministic_checks_json: string;
  evidence_json: string;
  reason: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: string;
  goal_id: string;
  task_id: string | null;
  attempt_id: string | null;
  seq: number;
  timestamp: number;
  type: string;
  payload_json: string;
  confidence: number;
}

function decodeGoal(row: GoalRow): StoredGoal {
  assertGoalStatus(row.status);
  const currentTaskId = row.current_task_id === null ? undefined : row.current_task_id;
  const completedAt = row.completed_at === null ? undefined : row.completed_at;
  return {
    id: row.id,
    workspace: row.workspace,
    prompt: row.prompt,
    provider: row.provider,
    status: row.status,
    constraints: parseJson<JsonObject>(row.constraints_json, 'goal constraints'),
    roadmap: parseJson<readonly RoadmapItem[]>(row.roadmap_json, 'goal roadmap'),
    projectState: parseJson<JsonObject>(row.project_state_json, 'project state'),
    executionMemory: parseJson<JsonObject>(row.execution_memory_json, 'execution memory'),
    workingSet: parseJson<JsonObject>(row.working_set_json, 'working set'),
    ...(currentTaskId === undefined ? {} : { currentTaskId }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function decodeTask(row: TaskRow): StoredTask {
  assertTaskStatus(row.status);
  return {
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    objective: row.objective,
    acceptanceCriteria: parseJson<readonly string[]>(
      row.acceptance_criteria_json,
      'acceptance criteria',
    ),
    verification: parseJson<JsonObject>(row.verification_json, 'task verification'),
    constraints: parseJson<JsonObject>(row.constraints_json, 'task constraints'),
    maxAttempts: row.max_attempts,
    status: row.status,
    sequence: row.sequence,
    tentative: row.tentative === 1,
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}

function decodeAttempt(row: AttemptRow): StoredAttempt {
  assertAttemptStatus(row.status);
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNumber: row.attempt_number,
    provider: row.provider,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    status: row.status,
    ...(row.worker_result_json === null
      ? {}
      : { workerResult: parseJson<WorkerResult>(row.worker_result_json, 'worker result') }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}

function decodeVerification(row: VerificationRow): StoredVerificationRun {
  assertVerificationStatus(row.status);
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    status: row.status,
    criteria: parseJson<readonly string[]>(row.criteria_json, 'verification criteria'),
    deterministicChecks: parseJson<readonly JsonObject[]>(
      row.deterministic_checks_json,
      'deterministic checks',
    ),
    evidence: parseJson<readonly JsonObject[]>(row.evidence_json, 'verification evidence'),
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeEvent(row: EventRow): StoredOrchestratorEvent {
  return {
    id: row.id,
    goalId: row.goal_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    seq: row.seq,
    timestamp: row.timestamp,
    type: row.type,
    payload: parseJson<JsonObject>(row.payload_json, 'orchestrator event payload'),
    confidence: row.confidence,
  };
}

function stringifyJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Value is not JSON serializable.');
    return serialized;
  } catch (error) {
    throw new StorageCorruptPayloadError('Value cannot be serialized as JSON.', { cause: error });
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StorageCorruptPayloadError(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
