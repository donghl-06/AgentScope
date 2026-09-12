import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    provider: text('provider').notNull(),
    adapter: text('adapter').notNull(),
    status: text('status').notNull(),
    startedAt: integer('started_at', { mode: 'number' }).notNull(),
    endedAt: integer('ended_at', { mode: 'number' }),
    stateJson: text('state_json').notNull(),
    capabilitiesJson: text('capabilities_json').notNull(),
    workspaceJson: text('workspace_json'),
    hiddenAt: integer('hidden_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('sessions_project_status_idx').on(table.projectId, table.status),
    index('sessions_status_updated_idx').on(table.status, table.updatedAt),
  ],
);

export const turns = sqliteTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    status: text('status').notNull(),
    submittedAt: integer('submitted_at', { mode: 'number' }).notNull(),
    startedAt: integer('started_at', { mode: 'number' }),
    endedAt: integer('ended_at', { mode: 'number' }),
    title: text('title'),
    prompt: text('prompt'),
    providerTurnId: text('provider_turn_id'),
    stateJson: text('state_json').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('turns_session_sequence_unique').on(table.sessionId, table.sequence),
    index('turns_session_sequence_idx').on(table.sessionId, table.sequence),
    index('turns_session_status_updated_idx').on(table.sessionId, table.status, table.updatedAt),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    timestamp: integer('timestamp', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    sourceJson: text('source_json').notNull(),
    payloadJson: text('payload_json').notNull(),
    confidence: real('confidence').notNull(),
    rawRef: text('raw_ref'),
  },
  (table) => [
    uniqueIndex('events_session_seq_unique').on(table.sessionId, table.seq),
    index('events_session_seq_idx').on(table.sessionId, table.seq),
    index('events_session_timestamp_idx').on(table.sessionId, table.timestamp),
    index('events_session_type_idx').on(table.sessionId, table.type),
  ],
);

export const milestones = sqliteTable(
  'milestones',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    milestoneId: text('milestone_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    startedAt: integer('started_at', { mode: 'number' }),
    completedAt: integer('completed_at', { mode: 'number' }),
    metadataJson: text('metadata_json'),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('milestones_session_id_unique').on(table.sessionId, table.milestoneId),
    index('milestones_session_status_idx').on(table.sessionId, table.status),
  ],
);

export const etaSnapshots = sqliteTable(
  'eta_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    capturedAt: integer('captured_at', { mode: 'number' }).notNull(),
    minSeconds: real('min_seconds').notNull(),
    maxSeconds: real('max_seconds').notNull(),
    confidence: real('confidence').notNull(),
    reasonsJson: text('reasons_json').notNull(),
  },
  (table) => [index('eta_snapshots_session_captured_idx').on(table.sessionId, table.capturedAt)],
);

export const observerEvidence = sqliteTable(
  'observer_evidence',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').references(() => turns.id, { onDelete: 'set null' }),
    evidenceKey: text('evidence_key').notNull(),
    timestamp: integer('timestamp', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
    kind: text('kind').notNull(),
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [
    uniqueIndex('observer_evidence_session_key_unique').on(table.sessionId, table.evidenceKey),
    index('observer_evidence_session_timestamp_idx').on(table.sessionId, table.timestamp),
    index('observer_evidence_turn_timestamp_idx').on(table.turnId, table.timestamp),
  ],
);

export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    workspace: text('workspace').notNull(),
    prompt: text('prompt').notNull(),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    constraintsJson: text('constraints_json').notNull(),
    roadmapJson: text('roadmap_json').notNull(),
    projectStateJson: text('project_state_json').notNull(),
    executionMemoryJson: text('execution_memory_json').notNull(),
    workingSetJson: text('working_set_json').notNull(),
    currentTaskId: text('current_task_id'),
    activeRevision: integer('active_revision').notNull().default(0),
    archivedAt: integer('archived_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    completedAt: integer('completed_at', { mode: 'number' }),
  },
  (table) => [
    index('goals_status_updated_idx').on(table.status, table.updatedAt),
    index('goals_workspace_status_idx').on(table.workspace, table.status),
    index('goals_archived_updated_idx').on(table.archivedAt, table.updatedAt),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    acceptanceCriteriaJson: text('acceptance_criteria_json').notNull(),
    verificationJson: text('verification_json').notNull(),
    constraintsJson: text('constraints_json').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    status: text('status').notNull(),
    sequence: integer('sequence').notNull(),
    tentative: integer('tentative').notNull(),
    parentTaskId: text('parent_task_id'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    startedAt: integer('started_at', { mode: 'number' }),
    endedAt: integer('ended_at', { mode: 'number' }),
  },
  (table) => [
    index('tasks_goal_status_sequence_idx').on(table.goalId, table.status, table.sequence),
  ],
);

export const taskAttempts = sqliteTable(
  'task_attempts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    provider: text('provider').notNull(),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    workerResultJson: text('worker_result_json'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    startedAt: integer('started_at', { mode: 'number' }),
    endedAt: integer('ended_at', { mode: 'number' }),
  },
  (table) => [
    index('task_attempts_task_status_idx').on(table.taskId, table.status, table.attemptNumber),
  ],
);

export const verificationRuns = sqliteTable(
  'verification_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id').references(() => taskAttempts.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    criteriaJson: text('criteria_json').notNull(),
    deterministicChecksJson: text('deterministic_checks_json').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    reason: text('reason').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('verification_runs_task_created_idx').on(table.taskId, table.createdAt)],
);

export const orchestratorEvents = sqliteTable(
  'orchestrator_events',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    attemptId: text('attempt_id').references(() => taskAttempts.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    timestamp: integer('timestamp', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    confidence: real('confidence').notNull(),
  },
  (table) => [
    index('orchestrator_events_goal_seq_idx').on(table.goalId, table.seq),
    index('orchestrator_events_goal_timestamp_idx').on(table.goalId, table.timestamp),
  ],
);

export const goalInstructions = sqliteTable(
  'goal_instructions',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    status: text('status').notNull(),
    baseRevision: integer('base_revision').notNull(),
    appliedRevision: integer('applied_revision'),
    appliedTaskId: text('applied_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    appliedAttemptId: text('applied_attempt_id').references(() => taskAttempts.id, {
      onDelete: 'set null',
    }),
    decisionReason: text('decision_reason'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    appliedAt: integer('applied_at', { mode: 'number' }),
  },
  (table) => [
    index('goal_instructions_goal_status_created_idx').on(
      table.goalId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const roadmapRevisions = sqliteTable(
  'roadmap_revisions',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    parentRevision: integer('parent_revision'),
    source: text('source').notNull(),
    reason: text('reason').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('roadmap_revisions_goal_revision_unique').on(table.goalId, table.revision),
    index('roadmap_revisions_goal_revision_idx').on(table.goalId, table.revision),
  ],
);

export const roadmapRevisionItems = sqliteTable(
  'roadmap_revision_items',
  {
    revisionId: text('revision_id')
      .notNull()
      .references(() => roadmapRevisions.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    operation: text('operation').notNull(),
    tentative: integer('tentative').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
  },
  (table) => [
    uniqueIndex('roadmap_revision_items_revision_task_unique').on(table.revisionId, table.taskId),
    index('roadmap_revision_items_task_idx').on(table.taskId, table.revisionId),
  ],
);

export const memorySnapshots = sqliteTable(
  'memory_snapshots',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    memoryJson: text('memory_json').notNull(),
    sourcesJson: text('sources_json').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('memory_snapshots_goal_revision_unique').on(table.goalId, table.revision),
    index('memory_snapshots_goal_revision_idx').on(table.goalId, table.revision),
  ],
);

export const approvalRequests = sqliteTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    attemptId: text('attempt_id').references(() => taskAttempts.id, { onDelete: 'set null' }),
    riskLevel: text('risk_level').notNull(),
    action: text('action').notNull(),
    scopeJson: text('scope_json').notNull(),
    status: text('status').notNull(),
    decisionReason: text('decision_reason'),
    expiresAt: integer('expires_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'number' }),
  },
  (table) => [
    index('approval_requests_goal_status_created_idx').on(
      table.goalId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const goalRunLeases = sqliteTable(
  'goal_run_leases',
  {
    goalId: text('goal_id')
      .primaryKey()
      .references(() => goals.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    generation: integer('generation').notNull(),
    heartbeatAt: integer('heartbeat_at', { mode: 'number' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('goal_run_leases_expiry_idx').on(table.expiresAt)],
);

export const goalMetricSnapshots = sqliteTable(
  'goal_metric_snapshots',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    progress: real('progress').notNull(),
    etaJson: text('eta_json'),
    confidence: real('confidence').notNull(),
    reasonsJson: text('reasons_json').notNull(),
    capturedAt: integer('captured_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('goal_metric_snapshots_goal_captured_idx').on(table.goalId, table.capturedAt)],
);

export const orchestratorNotifications = sqliteTable(
  'orchestrator_notifications',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    deliveredAt: integer('delivered_at', { mode: 'number' }),
    readAt: integer('read_at', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('orchestrator_notifications_goal_event_unique').on(table.goalId, table.eventKey),
    index('orchestrator_notifications_goal_status_created_idx').on(
      table.goalId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const orchestratorCommands = sqliteTable(
  'orchestrator_commands',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    commandKind: text('command_kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    expectedRevision: integer('expected_revision'),
    status: text('status').notNull(),
    resultJson: text('result_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('orchestrator_commands_goal_key_unique').on(table.goalId, table.idempotencyKey),
    index('orchestrator_commands_goal_created_idx').on(table.goalId, table.createdAt),
    index('orchestrator_commands_goal_status_idx').on(table.goalId, table.status, table.updatedAt),
  ],
);

export const storageTables = {
  sessions,
  turns,
  events,
  milestones,
  etaSnapshots,
  observerEvidence,
  goals,
  tasks,
  taskAttempts,
  verificationRuns,
  orchestratorEvents,
  goalInstructions,
  roadmapRevisions,
  roadmapRevisionItems,
  memorySnapshots,
  approvalRequests,
  goalRunLeases,
  goalMetricSnapshots,
  orchestratorNotifications,
  orchestratorCommands,
};
