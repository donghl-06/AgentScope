import {
  INSTRUCTION_KINDS,
  INSTRUCTION_SOURCES,
  StorageError,
  type InstructionKind,
  type InstructionSource,
} from '@agentscope/storage';

export interface InstructionDraft {
  readonly id?: string;
  readonly kind: InstructionKind;
  readonly content: string;
  readonly source?: InstructionSource;
  readonly baseRevision?: number;
}

/**
 * Validate the small, user-facing instruction envelope before it reaches storage.
 * Storage repeats these checks so callers cannot bypass the boundary through another API.
 */
export function validateInstructionDraft(input: InstructionDraft): void {
  if (!(INSTRUCTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new StorageError(`Unknown instruction kind: ${String(input.kind)}`, 'invalid_request');
  }
  if (
    input.source !== undefined &&
    !(INSTRUCTION_SOURCES as readonly string[]).includes(input.source)
  ) {
    throw new StorageError(
      `Unknown instruction source: ${String(input.source)}`,
      'invalid_request',
    );
  }
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new StorageError('Instruction content must not be empty.', 'invalid_request');
  }
  if (input.content.length > 16_000) {
    throw new StorageError(
      'Instruction content must be at most 16000 characters.',
      'invalid_request',
    );
  }
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' || input.id.trim().length === 0 || input.id.length > 200)
  ) {
    throw new StorageError(
      'Instruction id must be a non-empty string of at most 200 characters.',
      'invalid_request',
    );
  }
  if (
    input.baseRevision !== undefined &&
    (!Number.isInteger(input.baseRevision) || input.baseRevision < 0)
  ) {
    throw new StorageError(
      'Instruction base revision must be a non-negative integer.',
      'invalid_request',
    );
  }
}
