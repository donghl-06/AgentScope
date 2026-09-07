import { describe, expect, it } from 'vitest';

import { createInitialTurnState, type AgentEvent, type TurnState } from '@agentscope/protocol';

import { reduceTurnState } from './turn-reducer.js';

const source = { provider: 'mock', client: 'test', environment: 'test', adapter: 'mock' };

function event(
  type: AgentEvent['type'],
  payload: unknown,
  timestamp: number,
  sessionId = 'session-1',
): AgentEvent {
  return {
    id: type + '-' + timestamp,
    sessionId,
    timestamp,
    source,
    type,
    payload,
    confidence: 1,
  } as AgentEvent;
}

function turn(): TurnState {
  return createInitialTurnState('turn-1', 'session-1', 1, 100);
}

describe('reduceTurnState', () => {
  it('projects a normal turn lifecycle and observer verification', () => {
    const started = reduceTurnState(
      turn(),
      event('turn_started', { turnId: 'turn-1', sequence: 1, title: 'Implement' }, 110),
    );
    const testing = reduceTurnState(started, event('test_started', { testKind: 'unit' }, 120));
    const passed = reduceTurnState(testing, event('test_passed', { testKind: 'unit' }, 130));
    const completed = reduceTurnState(
      passed,
      event('turn_finished', { turnId: 'turn-1', reason: 'completed' }, 140),
    );

    expect(started).toMatchObject({ status: 'running', startedAt: 110, title: 'Implement' });
    expect(passed.verification.tests).toBe('passed');
    expect(completed).toMatchObject({ status: 'completed', endedAt: 140 });
  });

  it('keeps recoverable tool failures as evidence and allows later completion', () => {
    const started = reduceTurnState(
      turn(),
      event('turn_started', { turnId: 'turn-1', sequence: 1 }, 110),
    );
    const toolFailed = reduceTurnState(
      started,
      event('tool_call_finished', { toolName: 'search', success: false }, 120),
    );
    const completed = reduceTurnState(
      toolFailed,
      event('turn_finished', { turnId: 'turn-1', reason: 'completed' }, 130),
    );

    expect(toolFailed.status).toBe('running');
    expect(completed.status).toBe('completed');
  });

  it('handles waiting/blocked/interrupted states and protects terminal turns', () => {
    const started = reduceTurnState(
      turn(),
      event('turn_started', { turnId: 'turn-1', sequence: 1 }, 110),
    );
    const waiting = reduceTurnState(
      started,
      event('turn_updated', { turnId: 'turn-1', status: 'waiting' }, 120),
    );
    const blocked = reduceTurnState(
      waiting,
      event('turn_updated', { turnId: 'turn-1', status: 'blocked' }, 130),
    );
    const unblocked = reduceTurnState(
      blocked,
      event('unblocked', { reason: 'input received' }, 140),
    );
    const interrupted = reduceTurnState(
      unblocked,
      event('turn_finished', { turnId: 'turn-1', reason: 'interrupted' }, 150),
    );
    const lateUpdate = reduceTurnState(
      interrupted,
      event('turn_updated', { turnId: 'turn-1', status: 'running' }, 160),
    );

    expect(waiting.status).toBe('waiting');
    expect(blocked.status).toBe('blocked');
    expect(unblocked.status).toBe('running');
    expect(interrupted).toMatchObject({ status: 'interrupted', endedAt: 150 });
    expect(lateUpdate).toEqual(interrupted);
  });

  it('ignores unrelated turns, duplicate starts/finishes, and replays deterministically', () => {
    const events = [
      event('turn_started', { turnId: 'turn-1', sequence: 1 }, 110),
      event('turn_started', { turnId: 'turn-1', sequence: 1 }, 111),
      event('turn_finished', { turnId: 'other-turn', reason: 'completed' }, 120),
      event('agent_message', { summary: 'done' }, 130),
      event('turn_finished', { turnId: 'turn-1', reason: 'completed' }, 140),
      event('turn_finished', { turnId: 'turn-1', reason: 'failed' }, 150),
    ];
    const first = events.reduce(reduceTurnState, turn());
    const second = events.reduce(reduceTurnState, turn());

    expect(first).toEqual(second);
    expect(first.status).toBe('completed');
    expect(first.endedAt).toBe(140);
  });
});
