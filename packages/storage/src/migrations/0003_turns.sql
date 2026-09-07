CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  title TEXT,
  prompt TEXT,
  provider_turn_id TEXT,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE INDEX IF NOT EXISTS turns_session_sequence_idx
  ON turns(session_id, sequence);

CREATE INDEX IF NOT EXISTS turns_session_status_updated_idx
  ON turns(session_id, status, updated_at);
