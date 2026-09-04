import { describe, expect, it } from 'vitest';

import { mergeConfig } from './config.js';

describe('mergeConfig', () => {
  it('applies CLI > environment > file > defaults precedence', () => {
    const result = mergeConfig({
      defaults: { port: 4310, rawLog: false },
      file: { port: 4311 },
      env: { port: 4312, rawLog: true },
      cli: { port: 4313 },
    });

    expect(result).toEqual({ port: 4313, rawLog: true });
  });

  it('does not mutate source objects', () => {
    const defaults = { port: 4310 };
    const result = mergeConfig({ defaults });

    expect(result).toEqual(defaults);
    expect(Object.isFrozen(result)).toBe(true);
    expect(defaults).toEqual({ port: 4310 });
  });
});
