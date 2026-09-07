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

export const storageTables = {
  sessions,
  turns,
  events,
  milestones,
  etaSnapshots,
  observerEvidence,
};
