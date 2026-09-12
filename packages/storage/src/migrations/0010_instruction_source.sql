ALTER TABLE goal_instructions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';

CREATE INDEX IF NOT EXISTS goal_instructions_goal_source_created_idx
  ON goal_instructions(goal_id, source, created_at);
