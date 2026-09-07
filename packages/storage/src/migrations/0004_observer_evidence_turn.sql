ALTER TABLE observer_evidence ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS observer_evidence_turn_timestamp_idx
  ON observer_evidence(turn_id, timestamp);