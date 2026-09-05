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

export const storageTables = { sessions, events, milestones, etaSnapshots };
