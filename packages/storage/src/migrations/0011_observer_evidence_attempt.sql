ALTER TABLE observer_evidence ADD COLUMN attempt_id TEXT;

CREATE INDEX IF NOT EXISTS observer_evidence_attempt_timestamp_idx
  ON observer_evidence(attempt_id, timestamp);
