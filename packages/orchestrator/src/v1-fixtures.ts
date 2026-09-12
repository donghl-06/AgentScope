import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  CreateAttemptInput,
  CreateGoalInput,
  CreateTaskInput,
  CreateVerificationRunInput,
} from '@agentscope/storage';

export const V1_FIXTURE_NOW = 1_700_000_000_000;

export interface OrchestratorV1Fixture {
  readonly goal: CreateGoalInput;
  readonly task: CreateTaskInput;
  readonly attempt: CreateAttemptInput;
  readonly verification: CreateVerificationRunInput;
}

export interface TemporaryWorkspaceFixture {
  readonly workspace: string;
  readonly cleanup: () => void;
}

export function createOrchestratorV1Fixture(
  overrides: Partial<OrchestratorV1Fixture> = {},
): OrchestratorV1Fixture {
  const goal: CreateGoalInput = {
    id: 'v1-fixture-goal',
    workspace: 'D:/agentscope-v1-fixture',
    prompt: 'Implement a safe, verified fixture change.',
    provider: 'mock',
    constraints: { noRemotePush: true, singleWorker: true },
    roadmap: [
      {
        id: 'v1-fixture-task-1',
        title: 'Implement fixture change',
        objective: 'Make the fixture change and verify it.',
        status: 'LOCKED',
      },
    ],
    projectState: { packageManager: 'pnpm', isRepository: false },
    executionMemory: { decisions: [], completedTaskIds: [], notes: [] },
    workingSet: { files: ['src/index.ts'], directories: ['src'] },
    now: V1_FIXTURE_NOW,
  };
  const task: CreateTaskInput = {
    id: 'v1-fixture-task-1',
    goalId: goal.id,
    title: 'Implement fixture change',
    objective: 'Make the fixture change and verify it.',
    acceptanceCriteria: ['The fixture marker exists.'],
    verification: {
      checks: [
        {
          id: 'fixture-marker',
          label: 'fixture marker exists',
          executable: 'node',
          args: ['-e', "process.exit(require('fs').existsSync('fixture.marker') ? 0 : 1)"],
        },
      ],
    },
    constraints: { noRemotePush: true, singleWorker: true },
    maxAttempts: 3,
    sequence: 1,
    tentative: false,
    now: V1_FIXTURE_NOW + 1,
  };
  const attempt: CreateAttemptInput = {
    id: 'v1-fixture-attempt-1',
    taskId: task.id,
    attemptNumber: 1,
    provider: 'mock',
    sessionId: 'v1-fixture-session-1',
    now: V1_FIXTURE_NOW + 2,
  };
  const verification: CreateVerificationRunInput = {
    id: 'v1-fixture-verification-1',
    taskId: task.id,
    attemptId: attempt.id,
    status: 'PASS',
    criteria: ['The fixture marker exists.'],
    deterministicChecks: [{ id: 'fixture-marker', status: 'passed', exitCode: 0 }],
    evidence: [{ source: 'fixture', path: 'fixture.marker' }],
    reason: 'The deterministic fixture verification passed.',
    now: V1_FIXTURE_NOW + 3,
  };
  return {
    goal: { ...goal, ...overrides.goal },
    task: { ...task, ...overrides.task },
    attempt: { ...attempt, ...overrides.attempt },
    verification: { ...verification, ...overrides.verification },
  };
}

export function createTemporaryWorkspaceFixture(
  prefix = 'agentscope-v1-workspace-',
): TemporaryWorkspaceFixture {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'agentscope-v1-fixture',
        private: true,
        scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# AgentScope V1 fixture\n');
  fs.writeFileSync(path.join(workspace, '.env'), 'AGENTSCOPE_FIXTURE_SECRET=do-not-read\n');
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const fixture = true;\n');

  let cleaned = false;
  return {
    workspace,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}
