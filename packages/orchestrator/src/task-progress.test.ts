import { describe, expect, it } from 'vitest';

import type { StoredTask, StoredVerificationRun } from '@agentscope/storage';

import { projectTaskProgress } from './task-progress.js';

function task(status: StoredTask['status']): Pick<StoredTask, 'id' | 'status'> {
  return { id: 'task-progress', status };
}

function verification(status: StoredVerificationRun['status']): StoredVerificationRun {
  return {
    id: 'verification-1',
    taskId: 'task-progress',
    status,
    criteria: [],
    deterministicChecks: [],
    evidence: [],
    reason: status,
    createdAt: 10,
    updatedAt: 10,
  };
}

describe('Task progress projection', () => {
  it('maps lifecycle phases conservatively and completes at exactly 100%', () => {
    expect(projectTaskProgress({ task: task('PENDING') })).toMatchObject({
      phase: 'pending',
      value: 0,
      confidence: 0.1,
    });
    expect(projectTaskProgress({ task: task('RUNNING'), evidenceCount: 2 })).toMatchObject({
      phase: 'working',
      value: 0.35,
    });
    expect(
      projectTaskProgress({ task: task('COMPLETED'), verifications: [verification('PASS')] }),
    ).toMatchObject({
      phase: 'completed',
      value: 1,
      confidence: 1,
      verificationStatus: 'PASS',
    });
  });

  it('keeps provider-less active tasks low confidence instead of inventing detail', () => {
    const result = projectTaskProgress({ task: task('RUNNING') });

    expect(result.value).toBe(0.35);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reasons.map((reason) => reason.code)).toContain('task_evidence_sparse');
  });

  it('distinguishes verification and repair evidence', () => {
    const verifying = projectTaskProgress({
      task: task('VERIFYING'),
      verifications: [verification('UNCERTAIN')],
      evidenceCount: 3,
    });
    const repairing = projectTaskProgress({
      task: task('REPAIRING'),
      verifications: [verification('FAIL')],
      evidenceCount: 3,
    });

    expect(verifying.phase).toBe('verifying');
    expect(verifying.value).toBeGreaterThan(repairing.value);
    expect(repairing.phase).toBe('repairing');
    expect(repairing.reasons.map((reason) => reason.code)).toContain('task_repairing');
  });

  it('makes paused/error-like terminal states explicit', () => {
    expect(projectTaskProgress({ task: task('NEEDS_HUMAN') }).phase).toBe('needs-human');
    expect(projectTaskProgress({ task: task('FAILED') }).phase).toBe('failed');
    expect(projectTaskProgress({ task: task('SKIPPED') }).phase).toBe('skipped');
  });
});
