PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  state_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  workspace_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_project_status_idx ON sessions(project_id, status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  source_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  raw_ref TEXT,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS events_session_seq_idx ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_session_timestamp_idx ON events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS events_session_type_idx ON events(session_id, type);

CREATE TABLE IF NOT EXISTS milestones (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS milestones_session_status_idx ON milestones(session_id, status);

CREATE TABLE IF NOT EXISTS eta_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  min_seconds REAL NOT NULL,
  max_seconds REAL NOT NULL,
  confidence REAL NOT NULL,
  reasons_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS eta_snapshots_session_captured_idx ON eta_snapshots(session_id, captured_at);
