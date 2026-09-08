import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@agentscope/protocol';

import {
  classifyTurnInput,
  sanitizeTurnInput,
  TurnCoordinator,
  type TurnCoordinatorUpdate,
} from './turn-coordinator.js';

const source = { provider: 'mock', client: 'test', environment: 'test', adapter: 'mock' };

function event(type: AgentEvent['type'], payload: unknown, timestamp: number): AgentEvent {
  return {
    id: type + '-' + timestamp,
    sessionId: 'session-1',
    timestamp,
    source,
    type,
    payload,
    confidence: 1,
  } as AgentEvent;
}

describe('TurnCoordinator', () => {
  it('accepts a real task once, creates compact identity, and emits lifecycle updates', () => {
    const updates: TurnCoordinatorUpdate[] = [];
    const coordinator = new TurnCoordinator({
      sessionId: 'session-1',
      onUpdate: (update) => updates.push(update),
    });

    const first = coordinator.submitTask('Implement the feature\nwith a second line', 100);
    expect(first).toMatchObject({
      turnId: 'session-1:turn:1',
      sequence: 1,
      status: 'running',
      title: 'Implement the feature',
      prompt: 'Implement the feature\nwith a second line',
    });
    expect(coordinator.mode).toBe('running');
    expect(coordinator.submitTask('second task', 110)).toBeUndefined();

    const finished = coordinator.finish('completed', 120);
    expect(finished).toMatchObject({ status: 'completed', endedAt: 120 });
    expect(coordinator.mode).toBe('idle');
    expect(updates.map((update) => update.kind)).toEqual(['started', 'finished']);
  });

  it('does not misclassify empty, slash, approval, or control input', () => {
    expect(classifyTurnInput('')).toEqual({ accepted: false, reason: 'empty' });
    expect(classifyTurnInput('   \r\n')).toEqual({ accepted: false, reason: 'empty' });
    expect(classifyTurnInput('/exit')).toEqual({ accepted: false, reason: 'slash_command' });
    expect(classifyTurnInput('y')).toEqual({ accepted: false, reason: 'approval_key' });
    expect(classifyTurnInput('\u001b[6n')).toEqual({
      accepted: false,
      reason: 'control_sequence',
    });
    expect(classifyTurnInput('Please update the README')).toEqual({
      accepted: true,
      reason: 'task',
    });
  });

  it('redacts credential-shaped values and supports title-only persistence', () => {
    const input = 'Review token=super-secret-value and sk-kimi-abcdefghijklmnopqrstuvwxyz';
    expect(sanitizeTurnInput(input)).toBe('Review token=[REDACTED] and [REDACTED]');

    const titleOnly = new TurnCoordinator({ sessionId: 'session-1', persistPrompt: false });
    expect(titleOnly.submitTask(input, 100)).toMatchObject({
      title: 'Review token=[REDACTED] and [REDACTED]',
    });
    expect(titleOnly.current?.prompt).toBeUndefined();
  });

  it('removes terminal editing control characters from persisted task text', () => {
    expect(sanitizeTurnInput('\u0015Review the current task\u0007')).toBe(
      'Review the current task',
    );
  });

  it('preserves waiting/blocked semantics and resumes without creating another turn', () => {
    const coordinator = new TurnCoordinator({ sessionId: 'session-1' });
    coordinator.submitTask('Ask for input', 100);

    expect(coordinator.markWaiting(110)?.status).toBe('waiting');
    expect(coordinator.mode).toBe('waiting');
    expect(coordinator.submitTask('approval answer', 120)).toBeUndefined();
    expect(coordinator.markBlocked(130)?.status).toBe('blocked');
    expect(coordinator.resume(140)?.status).toBe('running');
    expect(coordinator.finish('interrupted', 150)?.status).toBe('interrupted');
    expect(coordinator.mode).toBe('idle');
  });

  it('starts the next sequence only after the previous turn is terminal', () => {
    const coordinator = new TurnCoordinator({ sessionId: 'session-1' });
    coordinator.submitTask('first', 100);
    coordinator.finish('completed', 110);
    const second = coordinator.submitTask('second', 120);

    expect(second).toMatchObject({ turnId: 'session-1:turn:2', sequence: 2 });
  });

  it('routes provider events to the active turn and ignores events after finish', () => {
    const coordinator = new TurnCoordinator({ sessionId: 'session-1' });
    coordinator.submitTask('run tests', 100);
    const passed = coordinator.observe(event('test_passed', { testKind: 'unit' }, 110));
    expect(passed?.verification.tests).toBe('passed');
    expect(coordinator.finish('completed', 120)?.status).toBe('completed');
    expect(coordinator.observe(event('agent_message', { summary: 'late' }, 130))).toBeUndefined();
  });
});
