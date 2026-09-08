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

  it('covers successful, failed, and interrupted terminal outcomes', () => {
    const completed = reduceSessionState(
      reduceSessionState(base, event('session_started', {})),
      event('session_finished', { reason: 'completed', exitCode: 0 }, 1_700_000_001_000),
    );
    const failed = reduceSessionState(
      reduceSessionState(base, event('session_started', {})),
      event('session_finished', { reason: 'failed', exitCode: 1 }, 1_700_000_001_000),
    );
    const interrupted = reduceSessionState(
      reduceSessionState(base, event('session_started', {})),
      event('session_finished', { reason: 'interrupted' }, 1_700_000_001_000),
    );

    expect(completed).toMatchObject({ status: 'completed', endedAt: 1_700_000_001_000 });
    expect(failed).toMatchObject({ status: 'failed', endedAt: 1_700_000_001_000 });
    expect(interrupted).toMatchObject({ status: 'interrupted', endedAt: 1_700_000_001_000 });
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

  it('projects provider metadata, usage snapshots, native event counts, and tool totals', () => {
    const withInfo = reduceSessionState(
      base,
      event('provider_info', {
        providerSessionId: 'provider-1',
        model: 'configured-model',
        cliVersion: '2.1.261',
      }),
    );
    const withUsage = reduceSessionState(
      withInfo,
      event('usage_updated', {
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalCostUsd: 0.0012,
          durationApiMs: 450,
        },
      }),
    );
    const withTool = reduceSessionState(
      withUsage,
      event('tool_call_started', { toolName: 'Bash', toolCallId: 'tool-1' }),
    );
    const withFinishedTool = reduceSessionState(
      withTool,
      event('tool_call_finished', {
        toolName: 'Bash',
        toolCallId: 'tool-1',
        success: false,
        errorCode: 'provider_tool_error',
      }),
    );
    const projected = reduceSessionState(
      withFinishedTool,
      event('provider_event', { providerEventType: 'stream_event', phase: 'message_delta' }),
    );

    expect(projected.telemetry).toMatchObject({
      providerInfo: { providerSessionId: 'provider-1', model: 'configured-model' },
      usage: { inputTokens: 12, outputTokens: 8, totalCostUsd: 0.0012 },
      toolCallCount: 1,
      toolCallFinishedCount: 1,
      toolCallErrorCount: 1,
      nativeEventCounts: { stream_event: 1, 'stream_event/message_delta': 1 },
    });
    expect(projected.conversation).toEqual({ id: 'provider-1', source: 'provider-session' });
  });

  it('projects persisted turn lifecycle events as session activity', () => {
    const started = reduceSessionState(
      base,
      event('turn_started', { turnId: 'turn-1', sequence: 1, title: 'Inspect workspace' }),
    );
    const waiting = reduceSessionState(
      started,
      event('turn_updated', { turnId: 'turn-1', status: 'waiting' }),
    );
    const finished = reduceSessionState(
      waiting,
      event('turn_finished', { turnId: 'turn-1', reason: 'completed' }),
    );

    expect(started.currentActivity).toMatchObject({
      kind: 'implementation',
      label: 'Inspect workspace',
    });
    expect(waiting.currentActivity).toMatchObject({ kind: 'planning', label: 'waiting for input' });
    expect(finished.currentActivity).toMatchObject({
      kind: 'implementation',
      label: 'task completed',
    });
  });

  it('projects observer-derived activity without presenting it as provider telemetry', () => {
    const projected = reduceSessionState(
      reduceSessionState(base, event('session_started', {})),
      event('observer_activity', {
        kind: 'file',
        label: 'workspace file modified',
        evidenceSource: 'filesystem',
        evidenceKind: 'file',
        evidenceKey: 'file:src/example.ts',
        summary: 'src/example.ts',
      }),
    );

    expect(projected.status).toBe('running');
    expect(projected.currentActivity).toMatchObject({
      kind: 'file',
      label: 'workspace file modified',
      source: 'mock',
    });
    expect(projected.telemetry).toBeUndefined();
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

  it('ignores duplicate and late events after a terminal transition', () => {
    const finished = reduceSessionState(
      reduceSessionState(base, event('session_started', {})),
      event('session_finished', { reason: 'completed' }, 1_700_000_001_000),
    );
    const duplicateFinish = reduceSessionState(
      finished,
      event('session_finished', { reason: 'failed', exitCode: 1 }, 1_700_000_002_000),
    );
    const lateActivity = reduceSessionState(
      finished,
      event('file_write', { path: 'late.ts' }, 1_699_999_999_000),
    );

    expect(duplicateFinish).toEqual(finished);
    expect(lateActivity).toEqual(finished);
  });

  it('keeps milestone completion idempotent for duplicate events', () => {
    const started = reduceSessionState(
      base,
      event('milestone_started', { milestoneId: 'm1', title: 'Implement' }),
    );
    const completed = reduceSessionState(
      started,
      event('milestone_completed', { milestoneId: 'm1', title: 'Implement' }, 1_700_000_001_000),
    );
    const duplicate = reduceSessionState(
      completed,
      event(
        'milestone_completed',
        { milestoneId: 'm1', title: 'Changed title' },
        1_700_000_002_000,
      ),
    );

    expect(duplicate).toEqual(completed);
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
