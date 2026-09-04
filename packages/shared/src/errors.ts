export const AGENTSCOPE_ERROR_CODES = {
  INVALID_INPUT: 'INVALID_INPUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type AgentScopeErrorCode =
  (typeof AGENTSCOPE_ERROR_CODES)[keyof typeof AGENTSCOPE_ERROR_CODES];

export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface AgentScopeErrorOptions {
  readonly cause?: unknown;
  readonly details?: ErrorDetails;
}

export class AgentScopeError extends Error {
  readonly code: AgentScopeErrorCode;
  readonly details?: ErrorDetails;

  constructor(code: AgentScopeErrorCode, message: string, options?: AgentScopeErrorOptions) {
    super(message);
    this.name = 'AgentScopeError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isAgentScopeError(error: unknown): error is AgentScopeError {
  return error instanceof AgentScopeError;
}
