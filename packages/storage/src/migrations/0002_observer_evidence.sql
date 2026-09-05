CREATE TABLE IF NOT EXISTS observer_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  evidence_key TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(session_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS observer_evidence_session_timestamp_idx
  ON observer_evidence(session_id, timestamp);
