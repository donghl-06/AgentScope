import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assertAgentEvent, assertSessionState, PROTOCOL_VERSION } from './index.js';

function readFixture(name: string): unknown {
  const fixtureUrl = new URL(
    `../../../tests/fixtures/normalized/protocol/${name}.json`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(fixtureUrl, 'utf8')) as unknown;
}

describe('normalized protocol golden fixtures', () => {
  it('accepts the canonical AgentEvent fixture', () => {
    const event = readFixture('agent-event');
    expect(() => assertAgentEvent(event)).not.toThrow();
  });

  it('accepts the canonical SessionState fixture for the current protocol version', () => {
    const state = readFixture('session-state');
    expect(() => assertSessionState(state)).not.toThrow();
    expect(PROTOCOL_VERSION).toBe('0.1');
  });
});
