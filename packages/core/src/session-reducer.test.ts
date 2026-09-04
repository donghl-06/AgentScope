import { describe, expect, it } from 'vitest';

import { type AgentEvent, createInitialSessionState } from '@agentscope/protocol';

import { reduceSessionState } from './session-reducer.js';

const source = { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' };
const base = createInitialSessionState('session-1', 1_700_000_000_000);

function event<T extends AgentEvent['type']>(
  type: T,
  payload: unknown,
  timestamp = 1_700_000_000_100,
): AgentEvent {
  return {
    id: `${type}-${timestamp}`,
    sessionId: 'session-1',
    timestamp,
    source,
    type,
    payload,
    confidence: 1,
  };
}

describe('reduceSessionState', () => {
  it('maps lifecycle, blocked/unblocked, and verification events', () => {
    const running = reduceSessionState(base, event('session_started', {}));
    const blocked = reduceSessionState(running, event('blocked', { reason: 'needs input' }));
    const unblocked = reduceSessionState(blocked, event('unblocked', {}));
    const failedTest = reduceSessionState(
      unblocked,
      event('test_failed', { testKind: 'unit', failureSummary: 'failed' }),
    );

    expect(running.status).toBe('running');
    expect(blocked.status).toBe('blocked');
    expect(blocked.currentActivity?.kind).toBe('blocked');
    expect(unblocked.status).toBe('running');
    expect(failedTest.verification.tests).toBe('failed');
    expect(failedTest.verification.overall).toBe('failed');
  });

  it('tracks milestones and command verification', () => {
    const active = reduceSessionState(
      base,
      event('milestone_started', { milestoneId: 'm1', title: 'Implement' }),
    );
    const completed = reduceSessionState(
      active,
      event('milestone_completed', { milestoneId: 'm1', title: 'Implement' }, 1_700_000_001_000),
    );
    const buildPending = reduceSessionState(
      completed,
      event('command_started', { commandKind: 'build', commandName: 'build' }),
    );
    const buildPassed = reduceSessionState(
      buildPending,
      event('command_finished', { commandKind: 'build', exitCode: 0 }),
    );

    expect(active.milestones[0]).toMatchObject({ id: 'm1', status: 'active' });
    expect(completed.milestones[0]).toMatchObject({ id: 'm1', status: 'completed' });
    expect(buildPending.verification.build).toBe('pending');
    expect(buildPassed.verification.build).toBe('passed');
  });

  it('maps completed-with-failed-verification to failed and never reopens terminal state', () => {
    const failed = reduceSessionState(
      reduceSessionState(base, event('test_failed', { testKind: 'unit' })),
      event('session_finished', { reason: 'completed', exitCode: 0 }),
    );
    const reopened = reduceSessionState(failed, event('file_write', { path: 'src/example.ts' }));

    expect(failed.status).toBe('failed');
    expect(failed.endedAt).toBe(1_700_000_000_100);
    expect(reopened).toEqual(failed);
  });

  it('keeps a blocked finish non-terminal and without endedAt', () => {
    const state = reduceSessionState(base, event('session_finished', { reason: 'blocked' }));

    expect(state.status).toBe('blocked');
    expect(state.endedAt).toBeUndefined();
  });

  it('is deterministic when the same event log is replayed', () => {
    const events = [
      event('session_started', {}, 1_700_000_000_100),
      event('planning', { summary: 'plan' }, 1_700_000_000_200),
      event('file_write', { path: 'src/example.ts' }, 1_700_000_000_300),
      event('session_finished', { reason: 'interrupted' }, 1_700_000_000_400),
    ];
    const first = events.reduce(reduceSessionState, base);
    const second = events.reduce(reduceSessionState, base);

    expect(second).toEqual(first);
  });
});
