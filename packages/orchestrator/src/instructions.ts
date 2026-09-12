import {
  INSTRUCTION_KINDS,
  INSTRUCTION_SOURCES,
  StorageError,
  type InstructionKind,
  type InstructionSource,
  type StoredGoal,
  type StoredGoalInstruction,
  type StoredTask,
} from '@agentscope/storage';

export interface InstructionDraft {
  readonly id?: string;
  readonly kind: InstructionKind;
  readonly content: string;
  readonly source?: InstructionSource;
  readonly baseRevision?: number;
}

export type InstructionApplicabilityDecision =
  'APPLY' | 'REJECT' | 'NEEDS_APPROVAL' | 'NEEDS_CLARIFICATION';

export interface InstructionApplicabilityResult {
  readonly decision: InstructionApplicabilityDecision;
  readonly reasonCode:
    | 'safe'
    | 'already_decided'
    | 'revision_conflict'
    | 'locked_constraint_conflict'
    | 'approval_required'
    | 'clarification_required';
  readonly reason: string;
  readonly lockedTaskIds: readonly string[];
  readonly riskSignals: readonly string[];
}

export interface InstructionApplicabilityInput {
  readonly goal: StoredGoal;
  readonly instruction: StoredGoalInstruction;
  readonly tasks: readonly StoredTask[];
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

/**
 * Decide whether a pending instruction can be applied at a safe boundary.
 * This is deliberately conservative: it never executes or mutates anything.
 */
export function evaluateInstructionApplicability(
  input: InstructionApplicabilityInput,
): InstructionApplicabilityResult {
  const lockedTaskIds = input.goal.roadmap
    .filter((item) => item.status === 'LOCKED')
    .map((item) => item.id)
    .filter((id) => input.tasks.some((task) => task.id === id));
  const content = input.instruction.content.trim();
  if (input.instruction.status !== 'PENDING') {
    return result(
      'REJECT',
      'already_decided',
      `Instruction is already ${input.instruction.status} and cannot be applied again.`,
      lockedTaskIds,
      [],
    );
  }
  if (input.instruction.baseRevision !== input.goal.activeRevision) {
    return result(
      'REJECT',
      'revision_conflict',
      `Instruction targets revision ${input.instruction.baseRevision}, but revision ${input.goal.activeRevision} is active.`,
      lockedTaskIds,
      [],
    );
  }
  const riskSignals = findRiskSignals(content);
  if (hasLockedOverrideIntent(content) && lockedTaskIds.length > 0) {
    return result(
      'REJECT',
      'locked_constraint_conflict',
      `Instruction attempts to override a LOCKED Task: ${lockedTaskIds.join(', ')}.`,
      lockedTaskIds,
      riskSignals,
    );
  }
  if (input.instruction.kind === 'approval-context' || riskSignals.length > 0) {
    return result(
      'NEEDS_APPROVAL',
      'approval_required',
      `Instruction requires explicit approval before it can be applied (${riskSignals.join(', ') || 'approval-context'}).`,
      lockedTaskIds,
      riskSignals,
    );
  }
  if (
    content.length < 8 ||
    (input.instruction.kind === 'clarification' && !/[?？]/u.test(content))
  ) {
    return result(
      'NEEDS_CLARIFICATION',
      'clarification_required',
      'Instruction is too short or ambiguous to apply safely; provide a concrete expected outcome.',
      lockedTaskIds,
      riskSignals,
    );
  }
  return result(
    'APPLY',
    'safe',
    'Instruction is compatible with the active revision and has no detected high-risk override.',
    lockedTaskIds,
    riskSignals,
  );
}

function result(
  decision: InstructionApplicabilityDecision,
  reasonCode: InstructionApplicabilityResult['reasonCode'],
  reason: string,
  lockedTaskIds: readonly string[],
  riskSignals: readonly string[],
): InstructionApplicabilityResult {
  return { decision, reasonCode, reason, lockedTaskIds, riskSignals };
}

function findRiskSignals(content: string): readonly string[] {
  const patterns: readonly [string, RegExp][] = [
    ['destructive', /\b(delete|remove|drop|destroy|reset|overwrite|force)\b/iu],
    ['remote-side-effect', /\b(push|deploy|publish|release)\b/iu],
    ['privilege', /\b(sudo|chmod|chown|permission|credential|secret|token|api[- ]?key)\b/iu],
    ['destructive', /\b(rm\s+-rf|format\s+disk)\b/iu],
    ['destructive', /(删除|销毁|重置|覆盖|强制|格式化)/u],
    ['remote-side-effect', /(推送|部署|发布|上线)/u],
    ['privilege', /(权限|凭据|密钥|令牌)/u],
  ];
  return [
    ...new Set(patterns.filter(([, pattern]) => pattern.test(content)).map(([signal]) => signal)),
  ];
}

function hasLockedOverrideIntent(content: string): boolean {
  if (/(do not|don't|never|avoid)\s+(skip|remove|delete|override)/iu.test(content)) return false;
  if (/(不要|勿|切勿)\s*(跳过|删除|覆盖|绕过)/u.test(content)) return false;
  return (
    /\b(skip|remove|delete|override|bypass|ignore|rewrite|unlock)\b/iu.test(content) ||
    /(跳过|删除|覆盖|绕过|忽略|重写|解锁)/u.test(content)
  );
}
