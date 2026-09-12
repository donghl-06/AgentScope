ALTER TABLE goals ADD COLUMN active_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN archived_at INTEGER;

CREATE INDEX IF NOT EXISTS goals_archived_updated_idx ON goals(archived_at, updated_at);

CREATE TABLE IF NOT EXISTS goal_instructions (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  applied_revision INTEGER,
  applied_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  applied_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  decision_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE INDEX IF NOT EXISTS goal_instructions_goal_status_created_idx
  ON goal_instructions(goal_id, status, created_at);

CREATE TABLE IF NOT EXISTS roadmap_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  parent_revision INTEGER,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(goal_id, revision)
);

CREATE INDEX IF NOT EXISTS roadmap_revisions_goal_revision_idx
  ON roadmap_revisions(goal_id, revision);

CREATE TABLE IF NOT EXISTS roadmap_revision_items (
  revision_id TEXT NOT NULL REFERENCES roadmap_revisions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  operation TEXT NOT NULL,
  tentative INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY(revision_id, task_id)
);

CREATE INDEX IF NOT EXISTS roadmap_revision_items_task_idx
  ON roadmap_revision_items(task_id, revision_id);

CREATE TABLE IF NOT EXISTS memory_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  memory_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(goal_id, revision)
);

CREATE INDEX IF NOT EXISTS memory_snapshots_goal_revision_idx
  ON memory_snapshots(goal_id, revision);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  risk_level TEXT NOT NULL,
  action TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX IF NOT EXISTS approval_requests_goal_status_created_idx
  ON approval_requests(goal_id, status, created_at);

CREATE TABLE IF NOT EXISTS goal_run_leases (
  goal_id TEXT PRIMARY KEY NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS goal_run_leases_expiry_idx
  ON goal_run_leases(expires_at);

CREATE TABLE IF NOT EXISTS goal_metric_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  progress REAL NOT NULL,
  eta_json TEXT,
  confidence REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS goal_metric_snapshots_goal_captured_idx
  ON goal_metric_snapshots(goal_id, captured_at);

CREATE TABLE IF NOT EXISTS orchestrator_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  UNIQUE(goal_id, event_key)
);

CREATE INDEX IF NOT EXISTS orchestrator_notifications_goal_status_created_idx
  ON orchestrator_notifications(goal_id, status, created_at);
