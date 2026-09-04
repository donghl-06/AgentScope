import { describe, expect, it } from 'vitest';

import { type AgentEvent } from './events.js';
import {
  assertAgentEvent,
  assertSessionState,
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

  it('validates the initial SessionState shape', () => {
    const state = createInitialSessionState('session-1', 1_700_000_000_000);

    expect(isSessionState(state)).toBe(true);
    expect(() => assertSessionState(state)).not.toThrow();
    expect(isSessionState({ ...state, progress: { ...state.progress, value: 2 } })).toBe(false);
  });
});
