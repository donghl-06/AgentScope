import { describe, expect, it } from 'vitest';

import { AGENTSCOPE_ERROR_CODES, AgentScopeError, isAgentScopeError } from './errors.js';

describe('AgentScopeError', () => {
  it('preserves a typed code and diagnostic details', () => {
    const error = new AgentScopeError(AGENTSCOPE_ERROR_CODES.INVALID_INPUT, 'Bad request', {
      details: { field: 'sessionId' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ field: 'sessionId' });
    expect(isAgentScopeError(error)).toBe(true);
    expect(isAgentScopeError(new Error('other'))).toBe(false);
  });
});
