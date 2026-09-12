import type { OrchestratorRepository, StoredGoal, StoredTask } from '@agentscope/storage';

export interface OrchestratorRecoveryReport {
  readonly goalsInspected: number;
  readonly goalsPaused: number;
  readonly tasksPaused: number;
  readonly attemptsPaused: number;
}

/**
 * Conservatively fences work that was active when the host process stopped.
 *
 * A restarted process cannot prove that a provider process is still alive, so
 * it must never launch a second Worker for the same Task automatically. The
 * explicit NEEDS_HUMAN state lets a later run resume only after the operator
 * has inspected the external process and made that decision.
 */
export function recoverOrchestrator(
  repository: OrchestratorRepository,
  now = Date.now(),
): OrchestratorRecoveryReport {
  let goalsInspected = 0;
  let goalsPaused = 0;
  let tasksPaused = 0;
  let attemptsPaused = 0;

  for (const goal of repository.listGoals()) {
    if (!isRecoverableGoal(goal)) continue;
    goalsInspected += 1;
    const tasks = repository.listTasks(goal.id);
    for (const task of tasks) {
      const attempts = repository.listAttempts(task.id);
      for (const attempt of attempts) {
        if (attempt.status !== 'RUNNING') continue;
        repository.updateAttempt(attempt.id, { status: 'NEEDS_HUMAN' }, now);
        attemptsPaused += 1;
        repository.appendEvent({
          id: `${goal.id}:recovery:${now}:attempt:${attempt.id}`,
          goalId: goal.id,
          taskId: task.id,
          attemptId: attempt.id,
          type: 'orchestrator.recovery.attempt_fenced',
          payload: { reason: 'The host restarted while the Attempt was running.' },
          confidence: 1,
          timestamp: now,
        });
      }
      if (!isRecoverableTask(task)) continue;
      repository.transitionTask(task.id, 'NEEDS_HUMAN', now);
      tasksPaused += 1;
      repository.appendEvent({
        id: `${goal.id}:recovery:${now}:task:${task.id}`,
        goalId: goal.id,
        taskId: task.id,
        type: 'orchestrator.recovery.task_fenced',
        payload: { reason: 'The host restarted before Task completion was verified.' },
        confidence: 1,
        timestamp: now,
      });
    }
    repository.transitionGoal(goal.id, 'NEEDS_HUMAN', now);
    goalsPaused += 1;
    repository.appendEvent({
      id: `${goal.id}:recovery:${now}:goal`,
      goalId: goal.id,
      type: 'orchestrator.recovery.goal_fenced',
      payload: { reason: 'The host restarted before Goal completion was verified.' },
      confidence: 1,
      timestamp: now,
    });
  }

  return { goalsInspected, goalsPaused, tasksPaused, attemptsPaused };
}

function isRecoverableGoal(goal: StoredGoal): boolean {
  return goal.status === 'PLANNING' || goal.status === 'RUNNING' || goal.status === 'VERIFYING';
}

function isRecoverableTask(task: StoredTask): boolean {
  return task.status === 'RUNNING' || task.status === 'VERIFYING' || task.status === 'REPAIRING';
}
