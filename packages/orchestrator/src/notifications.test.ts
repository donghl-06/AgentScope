import { describe, expect, it } from 'vitest';

import { notificationForGoalStatus, notificationForOrchestratorEvent } from './notifications.js';

describe('orchestrator notification rules', () => {
  it('notifies on human attention and dedupes the same reason key', () => {
    const event = {
      id: 'event-1',
      goalId: 'goal-1',
      taskId: 'task-1',
      type: 'goal.needs_human',
      payload: { reason: 'Approval is required.' },
    } as const;
    expect(notificationForOrchestratorEvent(event)).toEqual({
      goalId: 'goal-1',
      eventKey: expect.stringMatching(/^needs-human:task-1:[0-9a-f]{16}$/u),
      kind: 'needs-human',
      payload: { reason: 'Approval is required.', taskId: 'task-1' },
    });
    expect(notificationForOrchestratorEvent({ ...event, id: 'event-replay' })).toEqual(
      notificationForOrchestratorEvent(event),
    );
  });

  it('covers approval and budget severity without treating progress as actionable', () => {
    expect(
      notificationForOrchestratorEvent({
        id: 'approval-event',
        goalId: 'goal-1',
        type: 'goal.approval.requested',
        payload: { approvalId: 'approval-1', riskLevel: 'HIGH' },
      }),
    ).toMatchObject({ kind: 'approval', eventKey: 'approval:approval-1:requested' });
    expect(
      notificationForOrchestratorEvent({
        id: 'budget-event',
        goalId: 'goal-1',
        type: 'goal.budget.exceeded',
        payload: { key: 'hard:wall-clock', metric: 'elapsedMs', observed: 120, limit: 100 },
      }),
    ).toMatchObject({
      kind: 'budget-exceeded',
      eventKey: expect.stringMatching(/^budget:exceeded:[0-9a-f]{16}$/u),
    });
    expect(
      notificationForOrchestratorEvent({
        id: 'metric-event',
        goalId: 'goal-1',
        type: 'goal.metrics.updated',
        payload: { progress: 0.5 },
      }),
    ).toBeUndefined();
  });

  it('notifies once for terminal Goal status and recovery failures', () => {
    expect(notificationForGoalStatus({ id: 'goal-1', status: 'COMPLETED' })).toEqual({
      goalId: 'goal-1',
      eventKey: 'goal-status:completed',
      kind: 'completed',
      payload: { status: 'COMPLETED' },
    });
    expect(notificationForGoalStatus({ id: 'goal-1', status: 'RUNNING' })).toBeUndefined();
    expect(
      notificationForOrchestratorEvent({
        id: 'failed-event',
        goalId: 'goal-1',
        type: 'goal.run_failed',
        payload: { reason: 'Provider stopped unexpectedly.' },
      }),
    ).toMatchObject({
      kind: 'recovery-failed',
      eventKey: expect.stringMatching(/^recovery-failed:[0-9a-f]{16}$/u),
    });
  });
});
