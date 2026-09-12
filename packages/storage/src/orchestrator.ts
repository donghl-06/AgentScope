import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  StorageConflictError,
  StorageCorruptPayloadError,
  StorageError,
  StorageNotFoundError,
} from './repository.js';

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

export const INSTRUCTION_KINDS = [
  'clarification',
  'constraint',
  'priority',
  'approval-context',
  'general',
] as const;
export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];

export const INSTRUCTION_SOURCES = ['user', 'system', 'planner'] as const;
export type InstructionSource = (typeof INSTRUCTION_SOURCES)[number];

export const INSTRUCTION_STATUSES = [
  'PENDING',
  'APPLIED',
  'REJECTED',
  'NEEDS_APPROVAL',
  'NEEDS_CLARIFICATION',
  'SUPERSEDED',
] as const;
export type InstructionStatus = (typeof INSTRUCTION_STATUSES)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'DELIVERED', 'READ', 'DISMISSED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const COMMAND_STATUSES = ['PENDING', 'APPLIED', 'REJECTED'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

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
  readonly activeRevision: number;
  readonly archivedAt?: number;
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

export interface StoredGoalInstruction {
  readonly id: string;
  readonly goalId: string;
  readonly kind: InstructionKind;
  readonly content: string;
  readonly source: InstructionSource;
  readonly status: InstructionStatus;
  readonly baseRevision: number;
  readonly appliedRevision?: number;
  readonly appliedTaskId?: string;
  readonly appliedAttemptId?: string;
  readonly decisionReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly appliedAt?: number;
}

export interface RoadmapRevisionItemInput {
  readonly taskId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly tentative: boolean;
  readonly snapshot: JsonObject;
}

export type StoredRoadmapRevisionItem = RoadmapRevisionItemInput;

export interface StoredRoadmapRevision {
  readonly id: string;
  readonly goalId: string;
  readonly revision: number;
  readonly parentRevision?: number;
  readonly source: string;
  readonly reason: string;
  readonly createdAt: number;
  readonly items: readonly StoredRoadmapRevisionItem[];
}

export interface StoredMemorySnapshot {
  readonly id: string;
  readonly goalId: string;
  readonly revision: number;
  readonly memory: JsonObject;
  readonly sources: readonly JsonObject[];
  readonly createdAt: number;
}

export interface StoredApprovalRequest {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly riskLevel: string;
  readonly action: string;
  readonly scope: JsonObject;
  readonly status: ApprovalStatus;
  readonly decisionReason?: string;
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decidedAt?: number;
}

export interface StoredGoalRunLease {
  readonly goalId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredGoalMetricSnapshot {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly progress: number;
  readonly eta?: JsonObject;
  readonly confidence: number;
  readonly reasons: readonly JsonObject[];
  readonly capturedAt: number;
}

export interface StoredOrchestratorNotification {
  readonly id: string;
  readonly goalId: string;
  readonly eventKey: string;
  readonly kind: string;
  readonly status: NotificationStatus;
  readonly payload: JsonObject;
  readonly createdAt: number;
  readonly deliveredAt?: number;
  readonly readAt?: number;
}

export interface StoredOrchestratorCommand {
  readonly id: string;
  readonly goalId: string;
  readonly commandKind: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly expectedRevision?: number;
  readonly status: CommandStatus;
  readonly result?: JsonObject;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
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

export interface GoalListFilter {
  readonly status?: GoalStatus;
  readonly provider?: string;
  readonly workspace?: string;
  readonly query?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GoalPage {
  readonly items: readonly StoredGoal[];
  readonly nextCursor?: string;
}

export interface CreateInstructionInput {
  readonly id: string;
  readonly goalId: string;
  readonly kind: InstructionKind;
  readonly content: string;
  readonly source?: InstructionSource;
  readonly baseRevision?: number;
  readonly now?: number;
}

export interface CreateRoadmapRevisionInput {
  readonly id: string;
  readonly goalId: string;
  readonly parentRevision?: number;
  readonly source: string;
  readonly reason: string;
  readonly items: readonly RoadmapRevisionItemInput[];
  readonly expectedActiveRevision?: number;
  readonly now?: number;
}

export interface CreateMemorySnapshotInput {
  readonly id: string;
  readonly goalId: string;
  readonly revision: number;
  readonly memory: JsonObject;
  readonly sources?: readonly JsonObject[];
  readonly now?: number;
}

export interface CreateApprovalRequestInput {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly riskLevel: string;
  readonly action: string;
  readonly scope?: JsonObject;
  readonly expiresAt?: number;
  readonly now?: number;
}

export interface AcquireGoalRunLeaseInput {
  readonly goalId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly now?: number;
}

export interface CreateGoalMetricSnapshotInput {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly progress: number;
  readonly eta?: JsonObject;
  readonly confidence: number;
  readonly reasons?: readonly JsonObject[];
  readonly capturedAt?: number;
}

export interface CreateOrchestratorNotificationInput {
  readonly id: string;
  readonly goalId: string;
  readonly eventKey: string;
  readonly kind: string;
  readonly payload?: JsonObject;
  readonly now?: number;
}

export interface ReserveOrchestratorCommandInput {
  readonly id: string;
  readonly goalId: string;
  readonly commandKind: string;
  readonly idempotencyKey: string;
  readonly payload?: JsonObject;
  readonly expectedRevision?: number;
  readonly now?: number;
}

export interface OrchestratorCommandReservation {
  readonly replayed: boolean;
  readonly command: StoredOrchestratorCommand;
}

export interface ApplyInstructionAtBoundaryInput {
  readonly id: string;
  readonly status: Extract<
    InstructionStatus,
    'APPLIED' | 'REJECTED' | 'NEEDS_APPROVAL' | 'NEEDS_CLARIFICATION'
  >;
  readonly appliedRevision?: number;
  readonly appliedTaskId?: string;
  readonly appliedAttemptId?: string;
  readonly decisionReason: string;
  readonly executionMemory?: JsonObject;
  readonly workingSet?: JsonObject;
  readonly currentTaskId?: string | null;
  readonly event?: AppendOrchestratorEventInput;
  readonly now?: number;
}

export interface ApplyInstructionAtBoundaryResult {
  readonly goal: StoredGoal;
  readonly instruction: StoredGoalInstruction;
  readonly event?: StoredOrchestratorEvent;
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
  | {
      readonly type: 'instruction.created' | 'instruction.updated';
      readonly instruction: StoredGoalInstruction;
    }
  | { readonly type: 'roadmap.revised'; readonly revision: StoredRoadmapRevision }
  | { readonly type: 'memory.created'; readonly snapshot: StoredMemorySnapshot }
  | {
      readonly type: 'approval.created' | 'approval.updated';
      readonly approval: StoredApprovalRequest;
    }
  | { readonly type: 'lease.updated'; readonly lease: StoredGoalRunLease }
  | { readonly type: 'metric.created'; readonly metric: StoredGoalMetricSnapshot }
  | {
      readonly type: 'notification.created' | 'notification.updated';
      readonly notification: StoredOrchestratorNotification;
    }
  | {
      readonly type: 'command.created' | 'command.updated';
      readonly command: StoredOrchestratorCommand;
    }
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

export function assertInstructionKind(value: string): asserts value is InstructionKind {
  if (!(INSTRUCTION_KINDS as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown instruction kind: ${value}`);
  }
}

export function assertInstructionSource(value: string): asserts value is InstructionSource {
  if (!(INSTRUCTION_SOURCES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown instruction source: ${value}`);
  }
}

export function assertInstructionStatus(value: string): asserts value is InstructionStatus {
  if (!(INSTRUCTION_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown instruction status: ${value}`);
  }
}

export function assertApprovalStatus(value: string): asserts value is ApprovalStatus {
  if (!(APPROVAL_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown approval status: ${value}`);
  }
}

export function assertNotificationStatus(value: string): asserts value is NotificationStatus {
  if (!(NOTIFICATION_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown notification status: ${value}`);
  }
}

export function assertCommandStatus(value: string): asserts value is CommandStatus {
  if (!(COMMAND_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorStateError(`Unknown command status: ${value}`);
  }
}

const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  CREATED: ['PLANNING', 'PAUSED', 'NEEDS_HUMAN', 'ABORTED'],
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
    return this.listGoalPage({ limit, includeArchived: true }).items;
  }

  listGoalPage(filter: GoalListFilter = {}): GoalPage {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const limit = validateLimit(filter.limit ?? 100, 'Goal limit', 100);
    if (filter.includeArchived !== true) clauses.push('archived_at IS NULL');
    if (filter.status !== undefined) {
      assertGoalStatus(filter.status);
      clauses.push('status = ?');
      parameters.push(filter.status);
    }
    if (filter.provider !== undefined) {
      clauses.push('provider = ?');
      parameters.push(filter.provider);
    }
    if (filter.workspace !== undefined) {
      clauses.push('workspace = ?');
      parameters.push(filter.workspace);
    }
    if (filter.query !== undefined && filter.query.trim().length > 0) {
      clauses.push('(INSTR(LOWER(id), LOWER(?)) > 0 OR INSTR(LOWER(prompt), LOWER(?)) > 0)');
      const query = filter.query.trim();
      parameters.push(query, query);
    }
    if (filter.cursor !== undefined) {
      const cursor = decodeGoalCursor(filter.cursor);
      clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.client
      .prepare(
        `SELECT * FROM goals ${where}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1) as GoalRow[];
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(decodeGoal),
      ...(rows.length > limit && pageRows.length > 0
        ? { nextCursor: encodeGoalCursor(pageRows.at(-1)!) }
        : {}),
    };
  }

  archiveGoal(id: string, now = Date.now()): StoredGoal {
    const existing = this.getGoal(id);
    if (!isArchivableGoalStatus(existing.status)) {
      throw new OrchestratorStateError(
        `Goal ${id} cannot be archived while it is ${existing.status}.`,
      );
    }
    const lease = this.getGoalRunLease(id);
    if (lease !== undefined && lease.expiresAt > now) {
      throw new StorageConflictError(`Goal ${id} still has an active run lease.`);
    }
    if (existing.archivedAt !== undefined) return existing;
    this.client
      .prepare('UPDATE goals SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    const goal = this.getGoal(id);
    this.notify({ type: 'goal.updated', goal });
    return goal;
  }

  unarchiveGoal(id: string, now = Date.now()): StoredGoal {
    const existing = this.getGoal(id);
    if (existing.archivedAt === undefined) return existing;
    this.client
      .prepare('UPDATE goals SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(now, id);
    const goal = this.getGoal(id);
    this.notify({ type: 'goal.updated', goal });
    return goal;
  }

  createInstruction(input: CreateInstructionInput): StoredGoalInstruction {
    const goal = this.getGoal(input.goalId);
    assertInstructionKind(input.kind);
    const source = input.source ?? 'user';
    assertInstructionSource(source);
    if (input.content.trim().length === 0) {
      throw new StorageError('Instruction content must not be empty.', 'invalid_request');
    }
    if (input.content.length > 16_000) {
      throw new StorageError(
        'Instruction content must be at most 16000 characters.',
        'invalid_request',
      );
    }
    const baseRevision = input.baseRevision ?? goal.activeRevision;
    assertNonNegativeInteger(baseRevision, 'Instruction base revision');
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO goal_instructions
          (id, goal_id, kind, content, source, status, base_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(input.id, input.goalId, input.kind, input.content, source, baseRevision, now, now);
    const instruction = this.getInstruction(input.id);
    this.notify({ type: 'instruction.created', instruction });
    return instruction;
  }

  getInstruction(id: string): StoredGoalInstruction {
    const row = this.client.prepare('SELECT * FROM goal_instructions WHERE id = ?').get(id) as
      InstructionRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Instruction not found: ${id}`);
    return decodeInstruction(row);
  }

  listInstructions(
    goalId: string,
    options: { readonly status?: InstructionStatus; readonly limit?: number } = {},
  ): readonly StoredGoalInstruction[] {
    this.getGoal(goalId);
    const limit = validateLimit(options.limit ?? 100, 'Instruction limit', 500);
    if (options.status !== undefined) assertInstructionStatus(options.status);
    const rows =
      options.status === undefined
        ? (this.client
            .prepare(
              'SELECT * FROM goal_instructions WHERE goal_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
            )
            .all(goalId, limit) as InstructionRow[])
        : (this.client
            .prepare(
              'SELECT * FROM goal_instructions WHERE goal_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT ?',
            )
            .all(goalId, options.status, limit) as InstructionRow[]);
    return rows.map(decodeInstruction);
  }

  transitionInstruction(
    id: string,
    status: InstructionStatus,
    patch: {
      readonly appliedRevision?: number | null;
      readonly appliedTaskId?: string | null;
      readonly appliedAttemptId?: string | null;
      readonly decisionReason?: string | null;
    } = {},
    now = Date.now(),
  ): StoredGoalInstruction {
    const existing = this.getInstruction(id);
    assertInstructionStatus(status);
    assertInstructionTransition(existing.status, status);
    if (
      status === 'APPLIED' &&
      patch.appliedRevision === undefined &&
      existing.appliedRevision === undefined
    ) {
      throw new StorageError(
        'Applied instructions must reference an active revision.',
        'invalid_request',
      );
    }
    if (patch.appliedRevision !== undefined && patch.appliedRevision !== null) {
      assertNonNegativeInteger(patch.appliedRevision, 'Applied revision');
    }
    const appliedAt = status === 'APPLIED' ? now : existing.appliedAt;
    this.client
      .prepare(
        `UPDATE goal_instructions
         SET status = ?, applied_revision = ?, applied_task_id = ?, applied_attempt_id = ?,
             decision_reason = ?, updated_at = ?, applied_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        patch.appliedRevision === undefined
          ? (existing.appliedRevision ?? null)
          : (patch.appliedRevision ?? null),
        patch.appliedTaskId === undefined
          ? (existing.appliedTaskId ?? null)
          : (patch.appliedTaskId ?? null),
        patch.appliedAttemptId === undefined
          ? (existing.appliedAttemptId ?? null)
          : (patch.appliedAttemptId ?? null),
        patch.decisionReason === undefined
          ? (existing.decisionReason ?? null)
          : (patch.decisionReason ?? null),
        now,
        appliedAt ?? null,
        id,
      );
    const instruction = this.getInstruction(id);
    this.notify({ type: 'instruction.updated', instruction });
    return instruction;
  }

  /**
   * Atomically apply a pending Instruction and its boundary context.
   *
   * The caller decides whether the Instruction is safe to apply. This method only
   * enforces storage invariants and commits the Instruction, Goal documents, and
   * optional audit event as one SQLite transaction.
   */
  applyInstructionAtBoundary(
    input: ApplyInstructionAtBoundaryInput,
  ): ApplyInstructionAtBoundaryResult {
    const existingInstruction = this.getInstruction(input.id);
    const existingGoal = this.getGoal(existingInstruction.goalId);
    assertInstructionStatus(input.status);
    assertInstructionTransition(existingInstruction.status, input.status);
    if (input.decisionReason.trim().length === 0 || input.decisionReason.length > 4_000) {
      throw new StorageError(
        'Instruction decision reason must be between 1 and 4000 characters.',
        'invalid_request',
      );
    }
    if (input.status === 'APPLIED') {
      if (input.appliedRevision === undefined) {
        throw new StorageError(
          'Applied instructions must reference an active revision.',
          'invalid_request',
        );
      }
      assertNonNegativeInteger(input.appliedRevision, 'Applied revision');
      if (input.appliedRevision !== existingGoal.activeRevision) {
        throw new StorageConflictError(
          `Instruction revision conflict: expected active revision ${existingGoal.activeRevision}, found ${input.appliedRevision}.`,
          'revision_conflict',
        );
      }
    }
    if (input.appliedTaskId !== undefined) {
      const task = this.getTask(input.appliedTaskId);
      if (task.goalId !== existingGoal.id) {
        throw new StorageError(
          `Applied Task ${input.appliedTaskId} belongs to another Goal.`,
          'invalid_request',
        );
      }
    }
    if (input.appliedAttemptId !== undefined) {
      const attempt = this.getAttempt(input.appliedAttemptId);
      const task = this.getTask(attempt.taskId);
      if (task.goalId !== existingGoal.id) {
        throw new StorageError(
          `Applied Attempt ${input.appliedAttemptId} belongs to another Goal.`,
          'invalid_request',
        );
      }
    }
    if (input.event !== undefined) {
      if (input.event.goalId !== existingGoal.id) {
        throw new StorageError(
          'Instruction boundary event belongs to another Goal.',
          'invalid_request',
        );
      }
      if (input.event.taskId !== undefined) {
        const task = this.getTask(input.event.taskId);
        if (task.goalId !== existingGoal.id) {
          throw new StorageError(
            'Instruction boundary event Task belongs to another Goal.',
            'invalid_request',
          );
        }
      }
      if (input.event.attemptId !== undefined) {
        const attempt = this.getAttempt(input.event.attemptId);
        const task = this.getTask(attempt.taskId);
        if (task.goalId !== existingGoal.id) {
          throw new StorageError(
            'Instruction boundary event Attempt belongs to another Goal.',
            'invalid_request',
          );
        }
      }
    }
    const now = input.now ?? Date.now();
    const appliedAt = input.status === 'APPLIED' ? now : existingInstruction.appliedAt;
    const run = this.client.transaction(() => {
      if (
        input.executionMemory !== undefined ||
        input.workingSet !== undefined ||
        input.currentTaskId !== undefined
      ) {
        this.client
          .prepare(
            `UPDATE goals SET constraints_json = ?, roadmap_json = ?, project_state_json = ?,
             execution_memory_json = ?, working_set_json = ?, current_task_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            stringifyJson(existingGoal.constraints),
            stringifyJson(existingGoal.roadmap),
            stringifyJson(existingGoal.projectState),
            stringifyJson(input.executionMemory ?? existingGoal.executionMemory),
            stringifyJson(input.workingSet ?? existingGoal.workingSet),
            input.currentTaskId === undefined
              ? (existingGoal.currentTaskId ?? null)
              : (input.currentTaskId ?? null),
            now,
            existingGoal.id,
          );
      }
      const updatedInstruction = this.client
        .prepare(
          `UPDATE goal_instructions
           SET status = ?, applied_revision = ?, applied_task_id = ?, applied_attempt_id = ?,
               decision_reason = ?, updated_at = ?, applied_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(
          input.status,
          input.appliedRevision ?? existingInstruction.appliedRevision ?? null,
          input.appliedTaskId ?? existingInstruction.appliedTaskId ?? null,
          input.appliedAttemptId ?? existingInstruction.appliedAttemptId ?? null,
          input.decisionReason,
          now,
          appliedAt ?? null,
          input.id,
          existingInstruction.status,
        );
      if (updatedInstruction.changes !== 1) {
        throw new StorageConflictError(
          `Instruction ${input.id} changed before the boundary could be applied.`,
          'conflict',
        );
      }
      if (input.event !== undefined) this.insertEvent(input.event, now);
    })();
    void run;
    const goal = this.getGoal(existingGoal.id);
    const instruction = this.getInstruction(input.id);
    const event = input.event === undefined ? undefined : this.getEvent(input.event.id);
    this.notify({ type: 'goal.updated', goal });
    this.notify({ type: 'instruction.updated', instruction });
    if (event !== undefined) this.notify({ type: 'event.appended', event });
    return { goal, instruction, ...(event === undefined ? {} : { event }) };
  }

  transitionGoal(id: string, status: GoalStatus, now = Date.now()): StoredGoal {
    assertGoalStatus(status);
    const existing = this.getGoal(id);
    assertGoalTransition(existing.status, status);
    const completedAt = status === 'COMPLETED' ? now : existing.completedAt;
    try {
      this.client
        .prepare('UPDATE goals SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(status, now, completedAt ?? null, id);
    } catch (error) {
      if (error instanceof Error && error.message.includes('goals_single_active_idx')) {
        throw new StorageConflictError(
          'Another Goal is already active. Complete, pause, or abort it before starting a new Goal.',
        );
      }
      throw error;
    }
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

  createRoadmapRevision(input: CreateRoadmapRevisionInput): StoredRoadmapRevision {
    const goal = this.getGoal(input.goalId);
    const parentRevision = input.parentRevision ?? goal.activeRevision;
    assertNonNegativeInteger(parentRevision, 'Roadmap parent revision');
    const expectedActiveRevision = input.expectedActiveRevision ?? parentRevision;
    assertNonNegativeInteger(expectedActiveRevision, 'Expected active revision');
    if (goal.activeRevision !== expectedActiveRevision) {
      throw new StorageConflictError(
        `Roadmap revision conflict: expected ${expectedActiveRevision}, found ${goal.activeRevision}.`,
      );
    }
    if (parentRevision !== goal.activeRevision) {
      throw new StorageConflictError(
        `Roadmap parent revision ${parentRevision} is not active revision ${goal.activeRevision}.`,
      );
    }
    validateRevisionItems(input.items);
    for (const item of input.items) {
      const task = this.getTask(item.taskId);
      if (task.goalId !== input.goalId) {
        throw new StorageError(
          `Roadmap item ${item.taskId} belongs to another Goal.`,
          'invalid_request',
        );
      }
    }
    const now = input.now ?? Date.now();
    const revision = goal.activeRevision + 1;
    const createRevision = this.client.transaction(() => {
      this.client
        .prepare(
          `INSERT INTO roadmap_revisions
            (id, goal_id, revision, parent_revision, source, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.goalId,
          revision,
          parentRevision === 0 ? null : parentRevision,
          input.source,
          input.reason,
          now,
        );
      const insertItem = this.client.prepare(
        `INSERT INTO roadmap_revision_items
          (revision_id, task_id, sequence, operation, tentative, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const item of input.items) {
        insertItem.run(
          input.id,
          item.taskId,
          item.sequence,
          item.operation,
          item.tentative ? 1 : 0,
          stringifyJson(item.snapshot),
        );
      }
      this.client
        .prepare('UPDATE goals SET active_revision = ?, updated_at = ? WHERE id = ?')
        .run(revision, now, input.goalId);
    });
    createRevision();
    const stored = this.getRoadmapRevision(input.id);
    this.notify({ type: 'roadmap.revised', revision: stored });
    const updatedGoal = this.getGoal(input.goalId);
    this.notify({ type: 'goal.updated', goal: updatedGoal });
    return stored;
  }

  getRoadmapRevision(id: string): StoredRoadmapRevision {
    const row = this.client.prepare('SELECT * FROM roadmap_revisions WHERE id = ?').get(id) as
      RoadmapRevisionRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Roadmap revision not found: ${id}`);
    const items = this.client
      .prepare(
        'SELECT * FROM roadmap_revision_items WHERE revision_id = ? ORDER BY sequence ASC, task_id ASC',
      )
      .all(id) as RoadmapRevisionItemRow[];
    return decodeRoadmapRevision(row, items);
  }

  listRoadmapRevisions(goalId: string, limit = 100): readonly StoredRoadmapRevision[] {
    this.getGoal(goalId);
    const rows = this.client
      .prepare('SELECT * FROM roadmap_revisions WHERE goal_id = ? ORDER BY revision ASC LIMIT ?')
      .all(goalId, validateLimit(limit, 'Roadmap revision limit', 500)) as RoadmapRevisionRow[];
    return rows.map((row) => {
      const items = this.client
        .prepare(
          'SELECT * FROM roadmap_revision_items WHERE revision_id = ? ORDER BY sequence ASC, task_id ASC',
        )
        .all(row.id) as RoadmapRevisionItemRow[];
      return decodeRoadmapRevision(row, items);
    });
  }

  createMemorySnapshot(input: CreateMemorySnapshotInput): StoredMemorySnapshot {
    this.getGoal(input.goalId);
    assertNonNegativeInteger(input.revision, 'Memory revision');
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO memory_snapshots
          (id, goal_id, revision, memory_json, sources_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.goalId,
        input.revision,
        stringifyJson(input.memory),
        stringifyJson(input.sources ?? []),
        now,
      );
    const snapshot = this.getMemorySnapshot(input.id);
    this.notify({ type: 'memory.created', snapshot });
    return snapshot;
  }

  getMemorySnapshot(id: string): StoredMemorySnapshot {
    const row = this.client.prepare('SELECT * FROM memory_snapshots WHERE id = ?').get(id) as
      MemorySnapshotRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Memory snapshot not found: ${id}`);
    return decodeMemorySnapshot(row);
  }

  listMemorySnapshots(goalId: string, limit = 100): readonly StoredMemorySnapshot[] {
    this.getGoal(goalId);
    const rows = this.client
      .prepare('SELECT * FROM memory_snapshots WHERE goal_id = ? ORDER BY revision ASC LIMIT ?')
      .all(goalId, validateLimit(limit, 'Memory snapshot limit', 500)) as MemorySnapshotRow[];
    return rows.map(decodeMemorySnapshot);
  }

  createApprovalRequest(input: CreateApprovalRequestInput): StoredApprovalRequest {
    const goal = this.getGoal(input.goalId);
    if (input.taskId !== undefined) {
      const task = this.getTask(input.taskId);
      if (task.goalId !== goal.id)
        throw new StorageError('Approval Task belongs to another Goal.', 'invalid_request');
    }
    if (input.attemptId !== undefined) {
      const attempt = this.getAttempt(input.attemptId);
      if (this.getTask(attempt.taskId).goalId !== goal.id) {
        throw new StorageError('Approval Attempt belongs to another Goal.', 'invalid_request');
      }
    }
    if (input.action.trim().length === 0 || input.riskLevel.trim().length === 0) {
      throw new StorageError(
        'Approval action and risk level must not be empty.',
        'invalid_request',
      );
    }
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO approval_requests
          (id, goal_id, task_id, attempt_id, risk_level, action, scope_json, status,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.goalId,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.riskLevel,
        input.action,
        stringifyJson(input.scope ?? {}),
        input.expiresAt ?? null,
        now,
        now,
      );
    const approval = this.getApprovalRequest(input.id);
    this.notify({ type: 'approval.created', approval });
    return approval;
  }

  getApprovalRequest(id: string): StoredApprovalRequest {
    const row = this.client.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as
      ApprovalRequestRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Approval request not found: ${id}`);
    return decodeApprovalRequest(row);
  }

  listApprovalRequests(
    goalId: string,
    options: { readonly status?: ApprovalStatus; readonly limit?: number } = {},
  ): readonly StoredApprovalRequest[] {
    this.getGoal(goalId);
    const limit = validateLimit(options.limit ?? 100, 'Approval request limit', 500);
    if (options.status !== undefined) assertApprovalStatus(options.status);
    const rows =
      options.status === undefined
        ? (this.client
            .prepare(
              'SELECT * FROM approval_requests WHERE goal_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
            )
            .all(goalId, limit) as ApprovalRequestRow[])
        : (this.client
            .prepare(
              'SELECT * FROM approval_requests WHERE goal_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT ?',
            )
            .all(goalId, options.status, limit) as ApprovalRequestRow[]);
    return rows.map(decodeApprovalRequest);
  }

  transitionApprovalRequest(
    id: string,
    status: ApprovalStatus,
    decisionReason?: string | null,
    now = Date.now(),
  ): StoredApprovalRequest {
    const existing = this.getApprovalRequest(id);
    assertApprovalStatus(status);
    assertApprovalTransition(existing.status, status);
    const decidedAt = status === 'PENDING' ? existing.decidedAt : now;
    this.client
      .prepare(
        `UPDATE approval_requests
         SET status = ?, decision_reason = ?, updated_at = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        decisionReason === undefined ? (existing.decisionReason ?? null) : (decisionReason ?? null),
        now,
        decidedAt ?? null,
        id,
      );
    const approval = this.getApprovalRequest(id);
    this.notify({ type: 'approval.updated', approval });
    return approval;
  }

  getGoalRunLease(goalId: string): StoredGoalRunLease | undefined {
    this.getGoal(goalId);
    const row = this.client
      .prepare('SELECT * FROM goal_run_leases WHERE goal_id = ?')
      .get(goalId) as LeaseRow | undefined;
    return row === undefined ? undefined : decodeLease(row);
  }

  acquireGoalRunLease(input: AcquireGoalRunLeaseInput): StoredGoalRunLease {
    this.getGoal(input.goalId);
    validatePositiveInteger(input.ttlMs, 'Lease TTL');
    if (input.ownerId.trim().length === 0) {
      throw new StorageError('Lease owner must not be empty.', 'invalid_request');
    }
    const now = input.now ?? Date.now();
    const acquire = this.client.transaction(() => {
      const existing = this.client
        .prepare('SELECT * FROM goal_run_leases WHERE goal_id = ?')
        .get(input.goalId) as LeaseRow | undefined;
      if (existing !== undefined && existing.expires_at > now) {
        throw new StorageConflictError(
          `Goal ${input.goalId} already has an active run lease owned by ${existing.owner_id}.`,
        );
      }
      const generation = existing === undefined ? 1 : existing.generation + 1;
      this.client
        .prepare(
          `INSERT INTO goal_run_leases
            (goal_id, owner_id, generation, heartbeat_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(goal_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             generation = excluded.generation,
             heartbeat_at = excluded.heartbeat_at,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.goalId,
          input.ownerId,
          generation,
          now,
          now + input.ttlMs,
          existing?.created_at ?? now,
          now,
        );
    });
    acquire();
    const lease = this.getGoalRunLease(input.goalId);
    if (lease === undefined) throw new StorageError('Lease was not persisted.', 'storage_error');
    this.notify({ type: 'lease.updated', lease });
    return lease;
  }

  renewGoalRunLease(
    goalId: string,
    ownerId: string,
    generation: number,
    ttlMs: number,
    now = Date.now(),
  ): StoredGoalRunLease {
    validatePositiveInteger(ttlMs, 'Lease TTL');
    assertPositiveInteger(generation, 'Lease generation');
    const existing = this.getGoalRunLease(goalId);
    if (
      existing === undefined ||
      existing.ownerId !== ownerId ||
      existing.generation !== generation ||
      existing.expiresAt <= now
    ) {
      throw new StorageConflictError(`Cannot renew lease for Goal ${goalId}.`);
    }
    this.client
      .prepare(
        `UPDATE goal_run_leases
         SET heartbeat_at = ?, expires_at = ?, updated_at = ?
         WHERE goal_id = ? AND owner_id = ? AND generation = ?`,
      )
      .run(now, now + ttlMs, now, goalId, ownerId, generation);
    const lease = this.getGoalRunLease(goalId);
    if (lease === undefined)
      throw new StorageError('Lease disappeared during renewal.', 'storage_error');
    this.notify({ type: 'lease.updated', lease });
    return lease;
  }

  releaseGoalRunLease(
    goalId: string,
    ownerId: string,
    generation: number,
    now = Date.now(),
  ): boolean {
    assertPositiveInteger(generation, 'Lease generation');
    const existing = this.getGoalRunLease(goalId);
    if (existing === undefined) return false;
    if (existing.ownerId !== ownerId || existing.generation !== generation) {
      throw new StorageConflictError(`Cannot release lease for Goal ${goalId}.`);
    }
    const result = this.client
      .prepare(
        `UPDATE goal_run_leases
         SET heartbeat_at = ?, expires_at = ?, updated_at = ?
         WHERE goal_id = ? AND owner_id = ? AND generation = ?`,
      )
      .run(now, now, now, goalId, ownerId, generation);
    if (result.changes > 0) {
      this.notify({
        type: 'lease.updated',
        lease: { ...existing, heartbeatAt: now, updatedAt: now, expiresAt: now },
      });
    }
    return result.changes > 0;
  }

  createGoalMetricSnapshot(input: CreateGoalMetricSnapshotInput): StoredGoalMetricSnapshot {
    this.getGoal(input.goalId);
    if (input.taskId !== undefined) {
      const task = this.getTask(input.taskId);
      if (task.goalId !== input.goalId) {
        throw new StorageError('Metric Task belongs to another Goal.', 'invalid_request');
      }
    }
    assertUnitInterval(input.progress, 'Metric progress');
    assertUnitInterval(input.confidence, 'Metric confidence');
    const capturedAt = input.capturedAt ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO goal_metric_snapshots
          (id, goal_id, task_id, progress, eta_json, confidence, reasons_json, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.goalId,
        input.taskId ?? null,
        input.progress,
        input.eta === undefined ? null : stringifyJson(input.eta),
        input.confidence,
        stringifyJson(input.reasons ?? []),
        capturedAt,
      );
    const metric = this.getGoalMetricSnapshot(input.id);
    this.notify({ type: 'metric.created', metric });
    return metric;
  }

  getGoalMetricSnapshot(id: string): StoredGoalMetricSnapshot {
    const row = this.client.prepare('SELECT * FROM goal_metric_snapshots WHERE id = ?').get(id) as
      MetricSnapshotRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Goal metric snapshot not found: ${id}`);
    return decodeMetricSnapshot(row);
  }

  listGoalMetricSnapshots(goalId: string, limit = 100): readonly StoredGoalMetricSnapshot[] {
    this.getGoal(goalId);
    const rows = this.client
      .prepare(
        'SELECT * FROM goal_metric_snapshots WHERE goal_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?',
      )
      .all(goalId, validateLimit(limit, 'Goal metric snapshot limit', 500)) as MetricSnapshotRow[];
    return rows.map(decodeMetricSnapshot);
  }

  createOrchestratorNotification(
    input: CreateOrchestratorNotificationInput,
  ): StoredOrchestratorNotification {
    this.getGoal(input.goalId);
    if (input.eventKey.trim().length === 0 || input.kind.trim().length === 0) {
      throw new StorageError(
        'Notification event key and kind must not be empty.',
        'invalid_request',
      );
    }
    const now = input.now ?? Date.now();
    this.client
      .prepare(
        `INSERT INTO orchestrator_notifications
          (id, goal_id, event_key, kind, status, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        input.id,
        input.goalId,
        input.eventKey,
        input.kind,
        stringifyJson(input.payload ?? {}),
        now,
      );
    const notification = this.getOrchestratorNotification(input.id);
    this.notify({ type: 'notification.created', notification });
    return notification;
  }

  getOrchestratorNotification(id: string): StoredOrchestratorNotification {
    const row = this.client
      .prepare('SELECT * FROM orchestrator_notifications WHERE id = ?')
      .get(id) as NotificationRow | undefined;
    if (row === undefined)
      throw new StorageNotFoundError(`Orchestrator notification not found: ${id}`);
    return decodeNotification(row);
  }

  listOrchestratorNotifications(
    goalId: string,
    options: { readonly status?: NotificationStatus; readonly limit?: number } = {},
  ): readonly StoredOrchestratorNotification[] {
    this.getGoal(goalId);
    const limit = validateLimit(options.limit ?? 100, 'Notification limit', 500);
    if (options.status !== undefined) assertNotificationStatus(options.status);
    const rows =
      options.status === undefined
        ? (this.client
            .prepare(
              'SELECT * FROM orchestrator_notifications WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(goalId, limit) as NotificationRow[])
        : (this.client
            .prepare(
              'SELECT * FROM orchestrator_notifications WHERE goal_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(goalId, options.status, limit) as NotificationRow[]);
    return rows.map(decodeNotification);
  }

  transitionOrchestratorNotification(
    id: string,
    status: NotificationStatus,
    now = Date.now(),
  ): StoredOrchestratorNotification {
    const existing = this.getOrchestratorNotification(id);
    assertNotificationStatus(status);
    assertNotificationTransition(existing.status, status);
    const deliveredAt = ['DELIVERED', 'READ'].includes(status)
      ? (existing.deliveredAt ?? now)
      : existing.deliveredAt;
    const readAt = status === 'READ' ? (existing.readAt ?? now) : existing.readAt;
    this.client
      .prepare(
        `UPDATE orchestrator_notifications
         SET status = ?, delivered_at = ?, read_at = ?
         WHERE id = ?`,
      )
      .run(status, deliveredAt ?? null, readAt ?? null, id);
    const notification = this.getOrchestratorNotification(id);
    this.notify({ type: 'notification.updated', notification });
    return notification;
  }

  reserveOrchestratorCommand(
    input: ReserveOrchestratorCommandInput,
  ): OrchestratorCommandReservation {
    this.getGoal(input.goalId);
    assertCommandText(input.id, 'Command id', 200);
    assertCommandText(input.commandKind, 'Command kind', 100);
    assertCommandText(input.idempotencyKey, 'Idempotency key', 200);
    const payload = input.payload ?? {};
    const payloadHash = hashJson(payload);
    const existingByKey = this.findOrchestratorCommandByKey(input.goalId, input.idempotencyKey);
    if (existingByKey !== undefined) {
      if (existingByKey.payloadHash !== payloadHash) {
        throw new StorageConflictError(
          `Idempotency key ${input.idempotencyKey} was already used with different command input.`,
          'idempotency_conflict',
        );
      }
      if (existingByKey.status === 'PENDING') {
        throw new StorageConflictError(
          `Command ${existingByKey.commandKind} with idempotency key ${input.idempotencyKey} is still in progress.`,
          'command_in_progress',
        );
      }
      return { replayed: true, command: existingByKey };
    }
    if (input.expectedRevision !== undefined) {
      assertNonNegativeInteger(input.expectedRevision, 'Expected revision');
      const goal = this.getGoal(input.goalId);
      if (goal.activeRevision !== input.expectedRevision) {
        throw new StorageConflictError(
          `Command revision conflict: expected ${input.expectedRevision}, found ${goal.activeRevision}.`,
          'revision_conflict',
        );
      }
    }
    const now = input.now ?? Date.now();
    try {
      this.client
        .prepare(
          `INSERT INTO orchestrator_commands
            (id, goal_id, command_kind, idempotency_key, payload_hash, expected_revision,
             status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          input.id,
          input.goalId,
          input.commandKind,
          input.idempotencyKey,
          payloadHash,
          input.expectedRevision ?? null,
          now,
          now,
        );
    } catch (error) {
      const existing = this.findOrchestratorCommandByKey(input.goalId, input.idempotencyKey);
      if (existing === undefined) throw error;
      if (existing.payloadHash !== payloadHash) {
        throw new StorageConflictError(
          `Idempotency key ${input.idempotencyKey} was already used with different command input.`,
          'idempotency_conflict',
        );
      }
      if (existing.status === 'PENDING') {
        throw new StorageConflictError(
          `Command ${existing.commandKind} with idempotency key ${input.idempotencyKey} is still in progress.`,
          'command_in_progress',
        );
      }
      return { replayed: true, command: existing };
    }
    const command = this.getOrchestratorCommand(input.id);
    this.notify({ type: 'command.created', command });
    return { replayed: false, command };
  }

  getOrchestratorCommand(id: string): StoredOrchestratorCommand {
    const row = this.client.prepare('SELECT * FROM orchestrator_commands WHERE id = ?').get(id) as
      CommandRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Orchestrator command not found: ${id}`);
    return decodeCommand(row);
  }

  listOrchestratorCommands(goalId: string, limit = 100): readonly StoredOrchestratorCommand[] {
    this.getGoal(goalId);
    const rows = this.client
      .prepare(
        'SELECT * FROM orchestrator_commands WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(goalId, validateLimit(limit, 'Command limit', 500)) as CommandRow[];
    return rows.map(decodeCommand);
  }

  completeOrchestratorCommand(
    id: string,
    result: JsonObject,
    now = Date.now(),
  ): StoredOrchestratorCommand {
    const existing = this.getOrchestratorCommand(id);
    if (existing.status === 'APPLIED') return existing;
    if (existing.status !== 'PENDING') {
      throw new StorageConflictError(`Command ${id} was already rejected.`);
    }
    this.client
      .prepare(
        `UPDATE orchestrator_commands
         SET status = 'APPLIED', result_json = ?, error_code = NULL, error_message = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(stringifyJson(result), now, id);
    const command = this.getOrchestratorCommand(id);
    this.notify({ type: 'command.updated', command });
    return command;
  }

  rejectOrchestratorCommand(
    id: string,
    errorCode: string,
    errorMessage: string,
    now = Date.now(),
  ): StoredOrchestratorCommand {
    const existing = this.getOrchestratorCommand(id);
    if (existing.status === 'REJECTED') return existing;
    if (existing.status !== 'PENDING') {
      throw new StorageConflictError(`Command ${id} was already applied.`);
    }
    assertCommandText(errorCode, 'Command error code', 100);
    assertCommandText(errorMessage, 'Command error message', 4_000);
    this.client
      .prepare(
        `UPDATE orchestrator_commands
         SET status = 'REJECTED', error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(errorCode, errorMessage, now, id);
    const command = this.getOrchestratorCommand(id);
    this.notify({ type: 'command.updated', command });
    return command;
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
    this.insertEvent(input, now);
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

  private insertEvent(input: AppendOrchestratorEventInput, now: number): void {
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
        input.timestamp ?? now,
        input.type,
        stringifyJson(input.payload ?? {}),
        input.confidence,
      );
  }

  private findOrchestratorCommandByKey(
    goalId: string,
    idempotencyKey: string,
  ): StoredOrchestratorCommand | undefined {
    const row = this.client
      .prepare('SELECT * FROM orchestrator_commands WHERE goal_id = ? AND idempotency_key = ?')
      .get(goalId, idempotencyKey) as CommandRow | undefined;
    return row === undefined ? undefined : decodeCommand(row);
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
  active_revision: number;
  archived_at: number | null;
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

interface InstructionRow {
  id: string;
  goal_id: string;
  kind: string;
  content: string;
  source: string;
  status: string;
  base_revision: number;
  applied_revision: number | null;
  applied_task_id: string | null;
  applied_attempt_id: string | null;
  decision_reason: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

interface RoadmapRevisionRow {
  id: string;
  goal_id: string;
  revision: number;
  parent_revision: number | null;
  source: string;
  reason: string;
  created_at: number;
}

interface RoadmapRevisionItemRow {
  revision_id: string;
  task_id: string;
  sequence: number;
  operation: string;
  tentative: number;
  snapshot_json: string;
}

interface MemorySnapshotRow {
  id: string;
  goal_id: string;
  revision: number;
  memory_json: string;
  sources_json: string;
  created_at: number;
}

interface ApprovalRequestRow {
  id: string;
  goal_id: string;
  task_id: string | null;
  attempt_id: string | null;
  risk_level: string;
  action: string;
  scope_json: string;
  status: string;
  decision_reason: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
}

interface LeaseRow {
  goal_id: string;
  owner_id: string;
  generation: number;
  heartbeat_at: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface MetricSnapshotRow {
  id: string;
  goal_id: string;
  task_id: string | null;
  progress: number;
  eta_json: string | null;
  confidence: number;
  reasons_json: string;
  captured_at: number;
}

interface NotificationRow {
  id: string;
  goal_id: string;
  event_key: string;
  kind: string;
  status: string;
  payload_json: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

interface CommandRow {
  id: string;
  goal_id: string;
  command_kind: string;
  idempotency_key: string;
  payload_hash: string;
  expected_revision: number | null;
  status: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

function decodeGoal(row: GoalRow): StoredGoal {
  assertGoalStatus(row.status);
  const currentTaskId = row.current_task_id === null ? undefined : row.current_task_id;
  const completedAt = row.completed_at === null ? undefined : row.completed_at;
  const archivedAt = row.archived_at === null ? undefined : row.archived_at;
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
    activeRevision: row.active_revision,
    ...(archivedAt === undefined ? {} : { archivedAt }),
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

function decodeInstruction(row: InstructionRow): StoredGoalInstruction {
  assertInstructionKind(row.kind);
  assertInstructionSource(row.source);
  assertInstructionStatus(row.status);
  return {
    id: row.id,
    goalId: row.goal_id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    status: row.status,
    baseRevision: row.base_revision,
    ...(row.applied_revision === null ? {} : { appliedRevision: row.applied_revision }),
    ...(row.applied_task_id === null ? {} : { appliedTaskId: row.applied_task_id }),
    ...(row.applied_attempt_id === null ? {} : { appliedAttemptId: row.applied_attempt_id }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
  };
}

function decodeRoadmapRevision(
  row: RoadmapRevisionRow,
  itemRows: readonly RoadmapRevisionItemRow[],
): StoredRoadmapRevision {
  return {
    id: row.id,
    goalId: row.goal_id,
    revision: row.revision,
    ...(row.parent_revision === null ? {} : { parentRevision: row.parent_revision }),
    source: row.source,
    reason: row.reason,
    createdAt: row.created_at,
    items: itemRows.map((item) => ({
      taskId: item.task_id,
      sequence: item.sequence,
      operation: item.operation,
      tentative: item.tentative === 1,
      snapshot: parseJson<JsonObject>(item.snapshot_json, 'roadmap revision item'),
    })),
  };
}

function decodeMemorySnapshot(row: MemorySnapshotRow): StoredMemorySnapshot {
  return {
    id: row.id,
    goalId: row.goal_id,
    revision: row.revision,
    memory: parseJson<JsonObject>(row.memory_json, 'memory snapshot'),
    sources: parseJson<readonly JsonObject[]>(row.sources_json, 'memory snapshot sources'),
    createdAt: row.created_at,
  };
}

function decodeApprovalRequest(row: ApprovalRequestRow): StoredApprovalRequest {
  assertApprovalStatus(row.status);
  return {
    id: row.id,
    goalId: row.goal_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    riskLevel: row.risk_level,
    action: row.action,
    scope: parseJson<JsonObject>(row.scope_json, 'approval scope'),
    status: row.status,
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
  };
}

function decodeLease(row: LeaseRow): StoredGoalRunLease {
  return {
    goalId: row.goal_id,
    ownerId: row.owner_id,
    generation: row.generation,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeMetricSnapshot(row: MetricSnapshotRow): StoredGoalMetricSnapshot {
  return {
    id: row.id,
    goalId: row.goal_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    progress: row.progress,
    ...(row.eta_json === null ? {} : { eta: parseJson<JsonObject>(row.eta_json, 'metric ETA') }),
    confidence: row.confidence,
    reasons: parseJson<readonly JsonObject[]>(row.reasons_json, 'metric reasons'),
    capturedAt: row.captured_at,
  };
}

function decodeNotification(row: NotificationRow): StoredOrchestratorNotification {
  assertNotificationStatus(row.status);
  return {
    id: row.id,
    goalId: row.goal_id,
    eventKey: row.event_key,
    kind: row.kind,
    status: row.status,
    payload: parseJson<JsonObject>(row.payload_json, 'notification payload'),
    createdAt: row.created_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.read_at === null ? {} : { readAt: row.read_at }),
  };
}

function decodeCommand(row: CommandRow): StoredOrchestratorCommand {
  assertCommandStatus(row.status);
  return {
    id: row.id,
    goalId: row.goal_id,
    commandKind: row.command_kind,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    ...(row.expected_revision === null ? {} : { expectedRevision: row.expected_revision }),
    status: row.status,
    ...(row.result_json === null
      ? {}
      : { result: parseJson<JsonObject>(row.result_json, 'command result') }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertInstructionTransition(from: InstructionStatus, to: InstructionStatus): void {
  if (from === to) return;
  const allowed: Readonly<Record<InstructionStatus, readonly InstructionStatus[]>> = {
    PENDING: ['APPLIED', 'REJECTED', 'NEEDS_APPROVAL', 'NEEDS_CLARIFICATION', 'SUPERSEDED'],
    APPLIED: [],
    REJECTED: [],
    NEEDS_APPROVAL: ['APPLIED', 'REJECTED', 'SUPERSEDED'],
    NEEDS_CLARIFICATION: ['APPLIED', 'REJECTED', 'SUPERSEDED'],
    SUPERSEDED: [],
  };
  if (!allowed[from].includes(to)) {
    throw new OrchestratorStateError(`Invalid Instruction transition: ${from} -> ${to}`);
  }
}

function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (from === to) return;
  const allowed: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
    PENDING: ['APPROVED', 'REJECTED', 'EXPIRED'],
    APPROVED: [],
    REJECTED: [],
    EXPIRED: [],
  };
  if (!allowed[from].includes(to)) {
    throw new OrchestratorStateError(`Invalid Approval transition: ${from} -> ${to}`);
  }
}

function assertNotificationTransition(from: NotificationStatus, to: NotificationStatus): void {
  if (from === to) return;
  const allowed: Readonly<Record<NotificationStatus, readonly NotificationStatus[]>> = {
    PENDING: ['DELIVERED', 'READ', 'DISMISSED'],
    DELIVERED: ['READ', 'DISMISSED'],
    READ: ['DISMISSED'],
    DISMISSED: [],
  };
  if (!allowed[from].includes(to)) {
    throw new OrchestratorStateError(`Invalid Notification transition: ${from} -> ${to}`);
  }
}

function isArchivableGoalStatus(status: GoalStatus): boolean {
  return ['PAUSED', 'NEEDS_HUMAN', 'COMPLETED', 'FAILED', 'ABORTED'].includes(status);
}

function validateRevisionItems(items: readonly RoadmapRevisionItemInput[]): void {
  const taskIds = new Set<string>();
  const sequences = new Set<number>();
  for (const item of items) {
    if (item.taskId.trim().length === 0 || item.operation.trim().length === 0) {
      throw new StorageError(
        'Roadmap revision items require taskId and operation.',
        'invalid_request',
      );
    }
    assertPositiveInteger(item.sequence, 'Roadmap item sequence');
    if (taskIds.has(item.taskId)) {
      throw new StorageError(`Duplicate roadmap task: ${item.taskId}`, 'invalid_request');
    }
    if (sequences.has(item.sequence)) {
      throw new StorageError(`Duplicate roadmap sequence: ${item.sequence}`, 'invalid_request');
    }
    taskIds.add(item.taskId);
    sequences.add(item.sequence);
  }
}

function validateLimit(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new StorageError(`${label} must be positive.`, 'invalid_query');
  return Math.min(value, max);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new StorageError(`${label} must be non-negative.`, 'invalid_request');
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1)
    throw new StorageError(`${label} must be positive.`, 'invalid_request');
}

function validatePositiveInteger(value: number, label: string): void {
  assertPositiveInteger(value, label);
}

function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new StorageError(`${label} must be between 0 and 1.`, 'invalid_request');
  }
}

function assertCommandText(value: string, label: string, maxLength: number): void {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new StorageError(
      `${label} must be non-empty and at most ${maxLength} characters.`,
      'invalid_request',
    );
  }
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

function hashJson(value: JsonObject): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function encodeGoalCursor(row: GoalRow): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id })).toString(
    'base64url',
  );
}

function decodeGoalCursor(cursor: string): { updatedAt: number; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (
      typeof value.updatedAt !== 'number' ||
      !Number.isFinite(value.updatedAt) ||
      value.updatedAt < 0 ||
      typeof value.id !== 'string' ||
      value.id.length === 0
    ) {
      throw new Error('invalid');
    }
    return { updatedAt: value.updatedAt, id: value.id };
  } catch (error) {
    throw new StorageError('Invalid Goal cursor.', 'invalid_query', { cause: error });
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StorageCorruptPayloadError(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
