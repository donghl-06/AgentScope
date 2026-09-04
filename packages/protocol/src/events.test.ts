import { describe, expect, it } from 'vitest';

import { AGENT_EVENT_TYPES, type AgentEventFor } from './events.js';

describe('AgentEvent contract', () => {
  it('keeps the V0 event type set stable and unique', () => {
    expect(AGENT_EVENT_TYPES).toHaveLength(18);
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
    expect(AGENT_EVENT_TYPES).toContain('session_finished');
    expect(AGENT_EVENT_TYPES).toContain('test_failed');
  });

  it('supports payload narrowing by event type', () => {
    const event: AgentEventFor<'command_finished'> = {
      id: 'event-1',
      sessionId: 'session-1',
      timestamp: 1_700_000_000_000,
      source: {
        provider: 'mock',
        client: 'agentscope',
        environment: 'test',
        adapter: 'mock',
      },
      type: 'command_finished',
      payload: { exitCode: 0 },
      confidence: 1,
    };

    expect(event.payload.exitCode).toBe(0);
  });
});
