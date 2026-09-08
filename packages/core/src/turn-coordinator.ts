import {
  createInitialTurnState,
  type AgentEvent,
  type TurnFinishReason,
  type TurnState,
} from '@agentscope/protocol';

import { reduceTurnState } from './turn-reducer.js';

export type TurnCoordinatorMode = 'idle' | 'running' | 'waiting' | 'blocked';

export type TurnCoordinatorUpdate =
  | { readonly kind: 'started'; readonly turn: TurnState }
  | { readonly kind: 'updated'; readonly turn: TurnState }
  | { readonly kind: 'finished'; readonly turn: TurnState };

export interface TurnCoordinatorOptions {
  readonly sessionId: string;
  /**
   * Keep the sanitized task text in the turn projection. Titles are still
   * retained when this is disabled so the Dashboard remains navigable.
   */
  readonly persistPrompt?: boolean;
  readonly onUpdate?: (update: TurnCoordinatorUpdate) => void;
}

export interface TurnInputClassification {
  readonly accepted: boolean;
  readonly reason:
    'task' | 'empty' | 'slash_command' | 'approval_key' | 'control_sequence' | 'active_turn';
}

const COORDINATOR_SOURCE = {
  provider: 'unknown',
  client: 'agentscope',
  environment: 'local',
  adapter: 'turn-coordinator',
} as const;

export function classifyTurnInput(input: string): TurnInputClassification {
  const normalized = input.replace(/\r\n?/gu, '\n').trim();
  if (normalized.length === 0) return { accepted: false, reason: 'empty' };
  if (normalized.startsWith('/')) return { accepted: false, reason: 'slash_command' };
  if (/^[yn]$/iu.test(normalized)) return { accepted: false, reason: 'approval_key' };
  if (/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/u.test(normalized)) {
    return { accepted: false, reason: 'control_sequence' };
  }
  return { accepted: true, reason: 'task' };
}

/** Remove common credential-shaped values before a task enters a projection. */
export function sanitizeTurnInput(input: string): string {
  return (
    input
      // Console editing keys (for example Ctrl+U) can be delivered alongside
      // the visible line. They must never become part of a persisted title or
      // prompt, while the original bytes continue to be forwarded to the PTY.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
      .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
      .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, (match) =>
        match.replace(/([:=]\s*)[^\s,;]+$/u, '$1[REDACTED]'),
      )
  );
}

export class TurnCoordinator {
  private currentTurn: TurnState | undefined;
  private nextSequence = 1;

  constructor(private readonly options: TurnCoordinatorOptions) {}

  get mode(): TurnCoordinatorMode {
    if (this.currentTurn === undefined) return 'idle';
    if (this.currentTurn.status === 'waiting') return 'waiting';
    if (this.currentTurn.status === 'blocked') return 'blocked';
    return 'running';
  }

  get current(): TurnState | undefined {
    return this.currentTurn;
  }

  submitTask(input: string, timestamp: number): TurnState | undefined {
    const classification = classifyTurnInput(input);
    if (!classification.accepted || this.currentTurn !== undefined) return undefined;
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const turnId = this.options.sessionId + ':turn:' + sequence;
    const sanitizedInput = sanitizeTurnInput(input);
    const prompt = this.options.persistPrompt === false ? undefined : sanitizedInput;
    const turn = reduceTurnState(
      createInitialTurnState(turnId, this.options.sessionId, sequence, timestamp, {
        ...(prompt === undefined ? {} : { prompt }),
        title: compactTitle(sanitizedInput),
      }),
      this.internalEvent('turn_started', timestamp, {
        turnId,
        sequence,
        title: compactTitle(sanitizedInput),
        ...(prompt === undefined ? {} : { prompt }),
      }),
    );
    this.currentTurn = turn;
    this.options.onUpdate?.({ kind: 'started', turn });
    return turn;
  }

  observe(event: AgentEvent): TurnState | undefined {
    if (this.currentTurn === undefined) return undefined;
    const next = reduceTurnState(this.currentTurn, event);
    if (next === this.currentTurn) return next;
    this.currentTurn = next;
    if (next.status === 'completed' || next.status === 'failed' || next.status === 'interrupted') {
      this.currentTurn = undefined;
      this.options.onUpdate?.({ kind: 'finished', turn: next });
    } else {
      this.options.onUpdate?.({ kind: 'updated', turn: next });
    }
    return next;
  }

  markWaiting(timestamp: number): TurnState | undefined {
    return this.applyUpdate(timestamp, { status: 'waiting' });
  }

  markBlocked(timestamp: number): TurnState | undefined {
    return this.applyUpdate(timestamp, { status: 'blocked' });
  }

  resume(timestamp: number): TurnState | undefined {
    return this.applyUpdate(timestamp, { status: 'running' });
  }

  finish(reason: TurnFinishReason, timestamp: number): TurnState | undefined {
    if (this.currentTurn === undefined) return undefined;
    const next = reduceTurnState(
      this.currentTurn,
      this.internalEvent('turn_finished', timestamp, {
        turnId: this.currentTurn.turnId,
        reason,
      }),
    );
    this.currentTurn = undefined;
    this.options.onUpdate?.({ kind: 'finished', turn: next });
    return next;
  }

  private applyUpdate(
    timestamp: number,
    update: { readonly status: 'running' | 'waiting' | 'blocked' },
  ): TurnState | undefined {
    if (this.currentTurn === undefined) return undefined;
    const next = reduceTurnState(
      this.currentTurn,
      this.internalEvent('turn_updated', timestamp, {
        turnId: this.currentTurn.turnId,
        ...update,
      }),
    );
    if (next === this.currentTurn) return next;
    this.currentTurn = next;
    this.options.onUpdate?.({ kind: 'updated', turn: next });
    return next;
  }

  private internalEvent(
    type: 'turn_started' | 'turn_updated' | 'turn_finished',
    timestamp: number,
    payload: unknown,
  ): AgentEvent {
    return {
      id: this.options.sessionId + ':coordinator:' + type + ':' + timestamp,
      sessionId: this.options.sessionId,
      timestamp,
      source: COORDINATOR_SOURCE,
      type,
      payload,
      confidence: 1,
    } as AgentEvent;
  }
}

function compactTitle(input: string): string {
  const firstLine = input.replace(/\r\n?/gu, '\n').split('\n')[0]?.trim() ?? '';
  return firstLine.length <= 120 ? firstLine : firstLine.slice(0, 117) + '...';
}
