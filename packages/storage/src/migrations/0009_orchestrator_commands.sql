CREATE TABLE IF NOT EXISTS orchestrator_commands (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  command_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  expected_revision INTEGER,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(goal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestrator_commands_goal_created_idx
  ON orchestrator_commands(goal_id, created_at);

CREATE INDEX IF NOT EXISTS orchestrator_commands_goal_status_idx
  ON orchestrator_commands(goal_id, status, updated_at);
