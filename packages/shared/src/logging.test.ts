import { describe, expect, it } from 'vitest';

import { redactSensitive } from './logging.js';

describe('redactSensitive', () => {
  it('redacts sensitive keys recursively while preserving safe values', () => {
    expect(
      redactSensitive({
        sessionId: 'session-1',
        apiKey: 'do-not-store',
        nested: { prompt: 'do-not-store', count: 2 },
        list: [{ token: 'do-not-store' }, 'safe'],
      }),
    ).toEqual({
      sessionId: 'session-1',
      apiKey: '[REDACTED]',
      nested: { prompt: '[REDACTED]', count: 2 },
      list: [{ token: '[REDACTED]' }, 'safe'],
    });
  });
});
