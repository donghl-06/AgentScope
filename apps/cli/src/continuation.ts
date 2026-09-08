import type { ContinuationRequest, SessionState } from '@agentscope/protocol';

/**
 * Read only explicit provider continuation flags. We deliberately do not infer
 * conversation identity from workspace, prompt text, or process ancestry.
 */
export function detectContinuation(args: readonly string[]): ContinuationRequest | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === '--continue' || argument === '-c') return { mode: 'continue' };
    if (argument === '--resume') {
      const reference = args[index + 1];
      return reference === undefined || reference.startsWith('-')
        ? { mode: 'resume' }
        : { mode: 'resume', reference };
    }
    if (argument.startsWith('--resume=')) {
      const reference = argument.slice('--resume='.length);
      return reference.length === 0 ? { mode: 'resume' } : { mode: 'resume', reference };
    }
  }
  return undefined;
}

export function applyContinuation(
  state: SessionState,
  continuation: ContinuationRequest | undefined,
): SessionState {
  if (continuation === undefined) return state;
  return {
    ...state,
    continuation,
    ...(continuation.mode === 'resume' && continuation.reference !== undefined
      ? {
          conversation: {
            id: continuation.reference,
            source: 'explicit-resume' as const,
          },
        }
      : {}),
  };
}
