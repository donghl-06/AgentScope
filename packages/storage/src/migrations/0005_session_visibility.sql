ALTER TABLE sessions ADD COLUMN hidden_at INTEGER;
CREATE INDEX IF NOT EXISTS sessions_hidden_updated_idx
  ON sessions(hidden_at, updated_at);
