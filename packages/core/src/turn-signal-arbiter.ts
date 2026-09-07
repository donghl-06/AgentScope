import type { TurnFinishReason, TurnState } from '@agentscope/protocol';

import { TurnCoordinator } from './turn-coordinator.js';

export type TurnSignalSource = 'hook' | 'pty' | 'observer' | 'manual';

export type TurnSignal =
  | {
      readonly kind: 'task_submitted';
      readonly prompt: string;
      readonly source: TurnSignalSource;
      readonly confidence: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'waiting' | 'blocked' | 'resumed';
      readonly source: TurnSignalSource;
      readonly confidence: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'finished';
      readonly reason: TurnFinishReason;
      readonly source: TurnSignalSource;
      readonly confidence: number;
      readonly timestamp: number;
    };

export interface TurnSignalArbiterOptions {
  readonly ptyConfidenceThreshold?: number;
}

export interface TurnSignalResult {
  readonly accepted: boolean;
  readonly reason:
    'accepted' | 'low_confidence' | 'invalid_confidence' | 'no_active_turn' | 'ignored';
  readonly turn?: TurnState;
}

/**
 * Applies the strongest available turn signal without allowing a noisy PTY
 * observation to override a reliable hook or explicit user action.
 */
export class TurnSignalArbiter {
  private readonly ptyConfidenceThreshold: number;

  constructor(
    private readonly coordinator: TurnCoordinator,
    options: TurnSignalArbiterOptions = {},
  ) {
    this.ptyConfidenceThreshold = options.ptyConfidenceThreshold ?? 0.8;
    if (
      !Number.isFinite(this.ptyConfidenceThreshold) ||
      this.ptyConfidenceThreshold < 0 ||
      this.ptyConfidenceThreshold > 1
    ) {
      throw new RangeError('ptyConfidenceThreshold must be between 0 and 1.');
    }
  }

  apply(signal: TurnSignal): TurnSignalResult {
    if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
      return { accepted: false, reason: 'invalid_confidence' };
    }
    if (signal.source === 'pty' && signal.confidence < this.ptyConfidenceThreshold) {
      return { accepted: false, reason: 'low_confidence' };
    }

    switch (signal.kind) {
      case 'task_submitted': {
        const turn = this.coordinator.submitTask(signal.prompt, signal.timestamp);
        return turn === undefined
          ? { accepted: false, reason: 'ignored' }
          : { accepted: true, reason: 'accepted', turn };
      }
      case 'waiting': {
        const turn = this.coordinator.markWaiting(signal.timestamp);
        return this.resultForActiveTurn(turn);
      }
      case 'blocked': {
        const turn = this.coordinator.markBlocked(signal.timestamp);
        return this.resultForActiveTurn(turn);
      }
      case 'resumed': {
        const turn = this.coordinator.resume(signal.timestamp);
        return this.resultForActiveTurn(turn);
      }
      case 'finished': {
        const turn = this.coordinator.finish(signal.reason, signal.timestamp);
        return this.resultForActiveTurn(turn);
      }
    }
  }

  private resultForActiveTurn(turn: TurnState | undefined): TurnSignalResult {
    if (turn === undefined) {
      return { accepted: false, reason: 'no_active_turn' };
    }
    return { accepted: true, reason: 'accepted', turn };
  }
}
