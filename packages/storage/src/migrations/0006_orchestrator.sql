CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY NOT NULL,
  workspace TEXT NOT NULL,
  prompt TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  roadmap_json TEXT NOT NULL,
  project_state_json TEXT NOT NULL,
  execution_memory_json TEXT NOT NULL,
  working_set_json TEXT NOT NULL,
  current_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS goals_status_updated_idx ON goals(status, updated_at);
CREATE INDEX IF NOT EXISTS goals_workspace_status_idx ON goals(workspace, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  tentative INTEGER NOT NULL,
  parent_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(goal_id, sequence)
);

CREATE INDEX IF NOT EXISTS tasks_goal_status_sequence_idx ON tasks(goal_id, status, sequence);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  worker_result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(task_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS task_attempts_task_status_idx ON task_attempts(task_id, status, attempt_number);
CREATE INDEX IF NOT EXISTS task_attempts_session_idx ON task_attempts(session_id);

CREATE TABLE IF NOT EXISTS verification_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  deterministic_checks_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_runs_task_created_idx ON verification_runs(task_id, created_at);

CREATE TABLE IF NOT EXISTS orchestrator_events (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  UNIQUE(goal_id, seq)
);

CREATE INDEX IF NOT EXISTS orchestrator_events_goal_seq_idx ON orchestrator_events(goal_id, seq);
CREATE INDEX IF NOT EXISTS orchestrator_events_goal_timestamp_idx ON orchestrator_events(goal_id, timestamp);
