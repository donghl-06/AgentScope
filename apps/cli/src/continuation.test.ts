import { describe, expect, it } from 'vitest';

import { createInitialSessionState } from '@agentscope/protocol';

import { applyContinuation, detectContinuation } from './continuation.js';

describe('conservative continuation metadata', () => {
  it('recognizes explicit resume references and equals syntax', () => {
    expect(detectContinuation(['-p', 'hello', '--resume', 'session-42'])).toEqual({
      mode: 'resume',
      reference: 'session-42',
    });
    expect(detectContinuation(['--resume=session-43'])).toEqual({
      mode: 'resume',
      reference: 'session-43',
    });
    expect(detectContinuation(['resume', 'thread-44'])).toEqual({
      mode: 'resume',
      reference: 'thread-44',
    });
    expect(detectContinuation(['resume', '--last'])).toEqual({ mode: 'resume' });
    expect(detectContinuation(['-m', 'resume'])).toBeUndefined();
  });

  it('recognizes continue without inventing a conversation id', () => {
    expect(detectContinuation(['--continue'])).toEqual({ mode: 'continue' });
    expect(detectContinuation(['-c'])).toEqual({ mode: 'continue' });
    const state = applyContinuation(createInitialSessionState('session-1', 1_700_000_000_000), {
      mode: 'continue',
    });
    expect(state.continuation).toEqual({ mode: 'continue' });
    expect(state.conversation).toBeUndefined();
  });

  it('links only an explicit resume reference and ignores unrelated arguments', () => {
    expect(detectContinuation(['--verbose', '-p', 'hello'])).toBeUndefined();
    expect(detectContinuation(['--resume'])).toEqual({ mode: 'resume' });
    const state = applyContinuation(createInitialSessionState('session-2', 1_700_000_000_000), {
      mode: 'resume',
      reference: 'session-99',
    });
    expect(state.conversation).toEqual({ id: 'session-99', source: 'explicit-resume' });
  });
});
