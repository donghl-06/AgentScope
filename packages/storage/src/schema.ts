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
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    completedAt: integer('completed_at', { mode: 'number' }),
  },
  (table) => [
    index('goals_status_updated_idx').on(table.status, table.updatedAt),
    index('goals_workspace_status_idx').on(table.workspace, table.status),
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
};
