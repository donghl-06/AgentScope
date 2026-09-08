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
  private lineBuffer = '';
  private activitySincePrompt = false;
  private approvalPrompt = false;
  private readonly emittedMarkers = new Set<string>();

  constructor(private readonly options: { readonly enablePromptCompletion?: boolean } = {}) {}

  ingest(chunk: string, timestamp: number): readonly TurnSignal[] {
    const cleanedChunk = stripAnsi(chunk);
    this.buffer = stripAnsi(this.buffer + cleanedChunk).slice(-8_192);
    const signals: TurnSignal[] = [];
    this.lineBuffer += cleanedChunk;
    const lines = this.lineBuffer.split(/\r?\n/u);
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const marker = line.match(
        /^\s*\[agentscope:turn-(waiting|blocked|resumed|finished)(?::([a-z]+))?\]\s*$/iu,
      );
      if (marker?.[1] !== undefined) {
        const kind = marker[1].toLowerCase();
        const markerKey = kind + ':' + (marker[2] ?? '') + ':' + timestamp;
        if (this.emittedMarkers.has(markerKey)) continue;
        this.emittedMarkers.add(markerKey);
        if (kind === 'finished') {
          const reason =
            marker[2] === 'failed' || marker[2] === 'interrupted' ? marker[2] : 'completed';
          signals.push({ kind: 'finished', reason, source: 'pty', confidence: 0.95, timestamp });
        } else {
          signals.push({
            kind: kind as 'waiting' | 'blocked' | 'resumed',
            source: 'pty',
            confidence: 0.95,
            timestamp,
          });
        }
        continue;
      }

      if (isApprovalPrompt(line)) {
        this.approvalPrompt = true;
        signals.push({ kind: 'waiting', source: 'pty', confidence: 0.9, timestamp });
        continue;
      }

      if (isPromptLine(line)) {
        const completed =
          this.options.enablePromptCompletion === true &&
          this.activitySincePrompt &&
          !this.approvalPrompt;
        signals.push(
          completed
            ? { kind: 'finished', reason: 'completed', source: 'pty', confidence: 0.88, timestamp }
            : { kind: 'waiting', source: 'pty', confidence: 0.55, timestamp },
        );
        this.activitySincePrompt = false;
        this.approvalPrompt = false;
        continue;
      }

      if (line.trim().length > 0) {
        this.activitySincePrompt = true;
        if (this.approvalPrompt) this.approvalPrompt = false;
      }
    }

    // A prompt can arrive without a newline while the PTY is still active.
    if (isPromptLine(this.lineBuffer)) {
      const completed =
        this.options.enablePromptCompletion === true &&
        this.activitySincePrompt &&
        !this.approvalPrompt;
      signals.push(
        completed
          ? { kind: 'finished', reason: 'completed', source: 'pty', confidence: 0.88, timestamp }
          : { kind: 'waiting', source: 'pty', confidence: 0.55, timestamp },
      );
      this.lineBuffer = '';
      this.activitySincePrompt = false;
      this.approvalPrompt = false;
    } else if (/(?:^|\n)\s*(?:>|❯|›)\s?$/u.test(this.buffer)) {
      signals.push({ kind: 'waiting', source: 'pty', confidence: 0.55, timestamp });
    }
    return deduplicateSignals(signals);
  }
}

function isPromptLine(line: string): boolean {
  return /^\s*(?:>|❯|›)\s*(?:(?:Try|Ask)\b.*)?$/iu.test(line);
}

function isApprovalPrompt(line: string): boolean {
  return /\b(?:allow|approve|permission|do you want to|yes\/no|y\/n)\b/iu.test(line);
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
  return (
    value
      // ANSI escape sequences intentionally contain control characters.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  );
}
