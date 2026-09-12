-- A single active Goal keeps the first Orchestrator slice serial across
-- multiple AgentScope processes. Paused, human-gated, and terminal Goals may
-- coexist in the history.
CREATE UNIQUE INDEX IF NOT EXISTS goals_single_active_idx
  ON goals ((1))
  WHERE status IN ('PLANNING', 'RUNNING', 'VERIFYING');
