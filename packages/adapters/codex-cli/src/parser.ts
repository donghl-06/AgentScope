import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentEventType, EventSource } from '@agentscope/protocol';

export interface CodexParserContext {
  readonly sessionId: string;
  readonly timestamp?: number;
  readonly source?: EventSource;
}

export interface CodexParseResult {
  readonly events: readonly AgentEvent[];
  readonly ignored: boolean;
  readonly malformed?: boolean;
}

export class CodexStreamDecoder {
  private buffer = '';

  constructor(private readonly context: CodexParserContext) {}

  push(chunk: string): CodexParseResult[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => parseCodexStreamLine(line, this.context));
  }

  flush(): CodexParseResult[] {
    if (this.buffer.length === 0) return [];
    const result = parseCodexStreamLine(this.buffer, this.context);
    this.buffer = '';
    return [result];
  }
}

const DEFAULT_SOURCE: EventSource = {
  provider: 'codex',
  client: 'codex-cli',
  environment: process.platform,
  adapter: 'codex-cli',
};

export function parseCodexStreamLine(line: string, context: CodexParserContext): CodexParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { events: [], ignored: true };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { events: [], ignored: false, malformed: true };
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { events: [], ignored: true };
  }
  const timestamp = context.timestamp ?? Date.now();
  const source = context.source ?? DEFAULT_SOURCE;
  const events = parseRecord(value, context.sessionId, timestamp, source);
  return { events, ignored: events.length === 0 };
}

function parseRecord(
  record: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): readonly AgentEvent[] {
  switch (record.type) {
    case 'thread.started':
      return [
        event('session_started', sessionId, timestamp, source, {
          ...(typeof record.thread_id === 'string' ? { providerSessionId: record.thread_id } : {}),
        }),
      ];
    case 'turn.started':
      return [event('planning', sessionId, timestamp, source, {})];
    case 'item.started':
      return parseItem(record.item, sessionId, timestamp, source, 'started');
    case 'item.completed':
      return parseItem(record.item, sessionId, timestamp, source, 'completed');
    case 'turn.completed':
      return [event('session_finished', sessionId, timestamp, source, { reason: 'completed' })];
    default:
      return [];
  }
}

function parseItem(
  value: unknown,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  phase: 'started' | 'completed',
): readonly AgentEvent[] {
  if (!isRecord(value) || typeof value.type !== 'string') return [];
  if (value.type === 'agent_message' && phase === 'completed') {
    return [event('agent_message', sessionId, timestamp, source, { summary: 'agent message' })];
  }
  if (value.type !== 'command_execution') return [];
  if (phase === 'started') {
    return [
      event('command_started', sessionId, timestamp, source, {
        commandKind: 'command',
        commandName: 'command execution',
      }),
    ];
  }
  const exitCode =
    typeof value.exit_code === 'number' ? value.exit_code : value.status === 'completed' ? 0 : 1;
  return [
    event('command_finished', sessionId, timestamp, source, {
      commandKind: 'command',
      exitCode,
    }),
  ];
}

function event<T extends AgentEventType>(
  type: T,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  payload: unknown,
): AgentEvent {
  return { id: randomUUID(), sessionId, timestamp, source, type, payload, confidence: 0.9 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
