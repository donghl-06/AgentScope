import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createOrchestratorV1Fixture,
  createTemporaryWorkspaceFixture,
  V1_FIXTURE_NOW,
} from './v1-fixtures.js';

describe('orchestrator v1 fixtures', () => {
  it('creates a deterministic goal, task, attempt, and verification scenario', () => {
    const first = createOrchestratorV1Fixture();
    const second = createOrchestratorV1Fixture();

    expect(first).toEqual(second);
    expect(first.goal.now).toBe(V1_FIXTURE_NOW);
    expect(first.task.goalId).toBe(first.goal.id);
    expect(first.attempt.taskId).toBe(first.task.id);
    expect(first.verification.attemptId).toBe(first.attempt.id);
  });

  it('creates a disposable workspace with discoverable and sensitive fixtures', () => {
    const fixture = createTemporaryWorkspaceFixture();
    try {
      expect(fs.existsSync(path.join(fixture.workspace, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.workspace, 'pnpm-lock.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.workspace, 'README.md'))).toBe(true);
      expect(fs.readFileSync(path.join(fixture.workspace, '.env'), 'utf8')).toContain(
        'AGENTSCOPE_FIXTURE_SECRET',
      );
      expect(fs.existsSync(path.join(fixture.workspace, 'src', 'index.ts'))).toBe(true);
    } finally {
      fixture.cleanup();
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.workspace)).toBe(false);
  });
});
