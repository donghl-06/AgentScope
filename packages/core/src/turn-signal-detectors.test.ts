import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@agentscope/protocol';

import { signalFromHookEvent, PtyTurnSignalDetector } from './turn-signal-detectors.js';

const source = { provider: 'mock', client: 'hook', environment: 'test', adapter: 'hook' };

function event(type: AgentEvent['type'], payload: unknown, timestamp: number): AgentEvent {
  return {
    id: type + '-' + timestamp,
    sessionId: 'session-1',
    timestamp,
    source,
    type,
    payload,
    confidence: 1,
  } as AgentEvent;
}

describe('turn signal detectors', () => {
  it('maps structured hook lifecycle events to high-confidence signals', () => {
    expect(
      signalFromHookEvent(
        event('turn_started', { turnId: 'turn-1', sequence: 1, prompt: 'Run tests' }, 100),
      ),
    ).toMatchObject({ kind: 'task_submitted', prompt: 'Run tests', confidence: 1 });
    expect(
      signalFromHookEvent(event('turn_updated', { turnId: 'turn-1', status: 'waiting' }, 110)),
    ).toMatchObject({ kind: 'waiting', confidence: 1 });
    expect(
      signalFromHookEvent(event('turn_finished', { turnId: 'turn-1', reason: 'completed' }, 120)),
    ).toMatchObject({ kind: 'finished', reason: 'completed', confidence: 1 });
  });

  it('ignores non-turn events and malformed hook payloads', () => {
    expect(signalFromHookEvent(event('agent_message', { summary: 'text' }, 100))).toBeUndefined();
    expect(signalFromHookEvent(event('turn_started', { turnId: 'turn-1' }, 110))).toBeUndefined();
    expect(
      signalFromHookEvent(
        event('turn_finished', { turnId: 'turn-1', reason: 'unknown-reason' }, 120),
      ),
    ).toBeUndefined();
  });

  it('keeps ordinary PTY prompt observations low confidence', () => {
    const detector = new PtyTurnSignalDetector();
    expect(detector.ingest('\u001b[2J\u001b[H> ', 100)).toEqual([
      { kind: 'waiting', source: 'pty', confidence: 0.55, timestamp: 100 },
    ]);
  });

  it('recognizes explicit PTY markers and deduplicates repeated chunks', () => {
    const detector = new PtyTurnSignalDetector();
    expect(detector.ingest('[agentscope:turn-finished:completed]\r\n', 200)).toEqual([
      { kind: 'finished', reason: 'completed', source: 'pty', confidence: 0.95, timestamp: 200 },
    ]);
    expect(detector.ingest('[agentscope:turn-finished:completed]\r\n', 200)).toEqual([]);
  });

  it('recognizes completion after activity in normal interactive mode', () => {
    const detector = new PtyTurnSignalDetector({ enablePromptCompletion: true });
    expect(detector.ingest('> Try "task"\r\n', 300)).toEqual([
      { kind: 'waiting', source: 'pty', confidence: 0.55, timestamp: 300 },
    ]);
    expect(detector.ingest('Working on the task...\r\n', 310)).toEqual([]);
    expect(detector.ingest('> Try "next"\r\n', 320)).toEqual([
      { kind: 'finished', reason: 'completed', source: 'pty', confidence: 0.88, timestamp: 320 },
    ]);
  });

  it('recognizes the Codex chevron prompt after activity', () => {
    const detector = new PtyTurnSignalDetector({ enablePromptCompletion: true });
    expect(detector.ingest('› ', 350)).toEqual([
      { kind: 'waiting', source: 'pty', confidence: 0.55, timestamp: 350 },
    ]);
    expect(detector.ingest('Codex is working...\r\n', 360)).toEqual([]);
    expect(detector.ingest('› ', 370)).toEqual([
      { kind: 'finished', reason: 'completed', source: 'pty', confidence: 0.88, timestamp: 370 },
    ]);
  });

  it('keeps approval prompts waiting instead of completing a turn', () => {
    const detector = new PtyTurnSignalDetector({ enablePromptCompletion: true });
    expect(detector.ingest('Working...\r\nAllow this command? [y/N]\r\n', 400)).toEqual([
      { kind: 'waiting', source: 'pty', confidence: 0.9, timestamp: 400 },
    ]);
    expect(detector.ingest('> Try "next"\r\n', 410)).toEqual([
      { kind: 'waiting', source: 'pty', confidence: 0.55, timestamp: 410 },
    ]);
  });
});
