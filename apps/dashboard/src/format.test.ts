import { describe, expect, it } from 'vitest';

import { formatDuration, formatTimestamp, statusLabel } from './format.js';

describe('dashboard formatting', () => {
  it('formats durations without making short sessions look precise', () => {
    expect(formatDuration(1_000, 1_000)).toBe('0s');
    expect(formatDuration(1_000, 62_000)).toBe('1m 1s');
    expect(formatDuration(1_000, 3_661_000)).toBe('1h 1m');
  });

  it('formats labels and timestamps through stable browser primitives', () => {
    expect(statusLabel('session_finished')).toBe('Session finished');
    expect(statusLabel('running')).toBe('Running');
    expect(formatTimestamp(123)).toEqual(expect.any(String));
  });
});
