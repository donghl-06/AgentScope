import type { AgentEvent } from '@agentscope/protocol';

import type { TurnSignal } from './turn-signal-arbiter.js';

export function signalFromHookEvent(event: AgentEvent): TurnSignal | undefined {
  if (event.type === 'turn_started') {
    const payload = event.payload as {
      prompt?: unknown;
      title?: unknown;
    };
    const prompt =
      typeof payload.prompt === 'string'
        ? payload.prompt
        : typeof payload.title === 'string'
          ? payload.title
          : '';
    if (prompt.length === 0) return undefined;
    return {
      kind: 'task_submitted',
      prompt,
      source: 'hook',
      confidence: 1,
      timestamp: event.timestamp,
    };
  }
  if (event.type === 'turn_updated') {
    const status = (event.payload as { status?: unknown }).status;
    const kind =
      status === 'waiting'
        ? 'waiting'
        : status === 'blocked'
          ? 'blocked'
          : status === 'running'
            ? 'resumed'
            : undefined;
    return kind === undefined
      ? undefined
      : { kind, source: 'hook', confidence: 1, timestamp: event.timestamp };
  }
  if (event.type === 'turn_finished') {
    const reason = (event.payload as { reason?: unknown }).reason;
    if (
      reason !== 'completed' &&
      reason !== 'failed' &&
      reason !== 'interrupted' &&
      reason !== 'blocked' &&
      reason !== 'unknown'
    ) {
      return undefined;
    }
    return {
      kind: 'finished',
      reason,
      source: 'hook',
      confidence: 1,
      timestamp: event.timestamp,
    };
  }
  return undefined;
}

export class PtyTurnSignalDetector {
  private buffer = '';
  private readonly emittedMarkers = new Set<string>();

  ingest(chunk: string, timestamp: number): readonly TurnSignal[] {
    this.buffer = stripAnsi(this.buffer + chunk).slice(-8_192);
    const signals: TurnSignal[] = [];
    for (const line of this.buffer.split(/\r?\n/u).slice(-8)) {
      const marker = line.match(
        /^\s*\[agentscope:turn-(waiting|blocked|resumed|finished)(?::([a-z]+))?\]\s*$/iu,
      );
      if (marker?.[1] === undefined) continue;
      const kind = marker[1].toLowerCase();
      const markerKey = kind + ':' + (marker[2] ?? '') + ':' + timestamp;
      if (this.emittedMarkers.has(markerKey)) continue;
      this.emittedMarkers.add(markerKey);
      if (kind === 'finished') {
        const reason =
          marker[2] === 'failed' || marker[2] === 'interrupted' ? marker[2] : 'completed';
        signals.push({
          kind: 'finished',
          reason,
          source: 'pty',
          confidence: 0.95,
          timestamp,
        });
      } else {
        signals.push({
          kind: kind as 'waiting' | 'blocked' | 'resumed',
          source: 'pty',
          confidence: 0.95,
          timestamp,
        });
      }
    }
    if (/(?:^|\n)\s*(?:>|❯)\s?$/u.test(this.buffer)) {
      signals.push({
        kind: 'waiting',
        source: 'pty',
        confidence: 0.55,
        timestamp,
      });
    }
    return deduplicateSignals(signals);
  }
}

function deduplicateSignals(signals: readonly TurnSignal[]): readonly TurnSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = signal.kind + ':' + signal.timestamp + ':' + signal.source;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}
