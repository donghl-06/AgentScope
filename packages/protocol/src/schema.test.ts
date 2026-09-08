import { describe, expect, it } from 'vitest';

import { AGENT_EVENT_TYPES, type AgentEvent } from './events.js';
import {
  assertAgentEvent,
  assertSessionState,
  findDuplicateEventIds,
  isAgentEvent,
  isSessionState,
  ProtocolValidationError,
} from './schema.js';
import { createInitialSessionState } from './session.js';
import { PROTOCOL_VERSION } from './version.js';

const validEvent: AgentEvent = {
  id: 'event-1',
  sessionId: 'session-1',
  timestamp: 1_700_000_000_000,
  source: { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' },
  type: 'agent_message',
  payload: { summary: 'safe summary' },
  confidence: 1,
};

describe('Protocol runtime schemas', () => {
  it('exposes a version for compatibility negotiation', () => {
    expect(PROTOCOL_VERSION).toBe('0.1');
  });

  it('accepts valid events and preserves new payload fields', () => {
    const eventWithExtension = {
      ...validEvent,
      payload: { summary: 'safe summary', futureField: { value: true } },
    };

    expect(isAgentEvent(eventWithExtension)).toBe(true);
    expect(() => assertAgentEvent(eventWithExtension)).not.toThrow();
    expect(JSON.parse(JSON.stringify(eventWithExtension))).toEqual(eventWithExtension);
  });

  it('rejects unknown event types and out-of-range confidence', () => {
    expect(isAgentEvent({ ...validEvent, type: 'provider_private_event' })).toBe(false);
    expect(isAgentEvent({ ...validEvent, confidence: 1.01 })).toBe(false);

    expect(() => assertAgentEvent({ ...validEvent, confidence: -0.1 })).toThrow(
      ProtocolValidationError,
    );
  });

  it('accepts every V0 event type with a payload envelope', () => {
    const payloads: Record<(typeof AGENT_EVENT_TYPES)[number], unknown> = {
      session_started: {},
      session_finished: { reason: 'completed' },
      turn_started: { turnId: 'turn-1', sequence: 1 },
      turn_updated: { turnId: 'turn-1', status: 'running' },
      turn_finished: { turnId: 'turn-1', reason: 'completed' },
      planning: {},
      agent_message: {},
      observer_activity: {
        kind: 'file',
        label: 'workspace file changed',
        evidenceSource: 'filesystem',
        evidenceKind: 'file',
        evidenceKey: 'file:src/index.ts',
      },
      tool_call_started: { toolName: 'tool' },
      tool_call_finished: { toolName: 'tool', toolCallId: 'call-1', success: true },
      file_read: { path: 'file.ts' },
      file_write: { path: 'file.ts' },
      command_started: {},
      command_finished: { exitCode: 0 },
      test_started: {},
      test_passed: {},
      test_failed: {},
      milestone_started: { milestoneId: 'm1' },
      milestone_completed: { milestoneId: 'm1' },
      provider_info: { model: 'model-1', toolCount: 3 },
      provider_event: { providerEventType: 'stream_event' },
      usage_updated: {
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          thinkingTokensDelta: 1,
          firstContentFrameMs: 10,
          permissionDenialCount: 0,
          turnCount: 1,
          terminalReason: 'completed',
          fastModeState: 'off',
          apiErrorStatus: 0,
        },
      },
      blocked: { reason: 'needs input' },
      unblocked: {},
      error: { code: 'E_TEST', message: 'failure' },
    };
    for (const type of AGENT_EVENT_TYPES) {
      expect(isAgentEvent({ ...validEvent, type, payload: payloads[type] })).toBe(true);
    }
  });

  it('rejects malformed payloads while preserving extension fields', () => {
    expect(isAgentEvent({ ...validEvent, type: 'file_write', payload: { path: 123 } })).toBe(false);
    expect(
      isAgentEvent({
        ...validEvent,
        type: 'session_finished',
        payload: { reason: 'completed', providerField: { value: true } },
      }),
    ).toBe(true);
  });

  it('rejects missing identifiers and invalid timestamps', () => {
    expect(isAgentEvent({ ...validEvent, id: undefined })).toBe(false);
    expect(isAgentEvent({ ...validEvent, timestamp: -1 })).toBe(false);
  });

  it('identifies duplicate event ids without choosing a dedupe policy', () => {
    expect(findDuplicateEventIds([validEvent, { ...validEvent, type: 'planning' }])).toEqual([
      'event-1',
    ]);
    expect(findDuplicateEventIds([validEvent])).toEqual([]);
  });

  it('validates the initial SessionState shape', () => {
    const state = createInitialSessionState('session-1', 1_700_000_000_000);

    expect(isSessionState(state)).toBe(true);
    expect(() => assertSessionState(state)).not.toThrow();
    expect(isSessionState({ ...state, progress: { ...state.progress, value: 2 } })).toBe(false);
  });

  it('validates normalized provider telemetry on session state', () => {
    const state = createInitialSessionState('session-telemetry', 1_700_000_000_000);
    const telemetryState = {
      ...state,
      telemetry: {
        providerInfo: { model: 'model-1', toolCount: 2 },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreation5mInputTokens: 3,
          thinkingTokensDelta: 2,
          serverToolUseRequests: 1,
          ttftStreamMs: 12,
        },
        nativeEventCounts: { assistant: 1, 'stream_event/message_delta': 2 },
        toolCallCount: 1,
        toolCallFinishedCount: 1,
        toolCallErrorCount: 0,
      },
    };
    expect(isSessionState(telemetryState)).toBe(true);
    expect(() => assertSessionState(telemetryState)).not.toThrow();
  });

  it('validates conservative continuation and conversation links', () => {
    const state = createInitialSessionState('session-continuation', 1_700_000_000_000);
    expect(
      isSessionState({
        ...state,
        continuation: { mode: 'resume', reference: 'provider-session-1' },
        conversation: { id: 'provider-session-1', source: 'explicit-resume' },
      }),
    ).toBe(true);
    expect(
      isSessionState({
        ...state,
        continuation: { mode: 'continue' },
        conversation: { id: '', source: 'provider-session' },
      }),
    ).toBe(false);
    expect(
      isSessionState({
        ...state,
        continuation: { mode: 'continue', reference: 'should-not-be-used' },
      }),
    ).toBe(true);
  });
});
