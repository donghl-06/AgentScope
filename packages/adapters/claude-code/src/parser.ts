import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentEventType, EventSource } from '@agentscope/protocol';

export interface ClaudeParserContext {
  readonly sessionId: string;
  readonly timestamp?: number;
  readonly source?: EventSource;
}

export interface ClaudeParseResult {
  readonly events: readonly AgentEvent[];
  readonly ignored: boolean;
  readonly malformed?: boolean;
}

export class ClaudeStreamDecoder {
  private buffer = '';

  constructor(private readonly context: ClaudeParserContext) {}

  push(chunk: string): ClaudeParseResult[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => parseClaudeStreamLine(line, this.context));
  }

  flush(): ClaudeParseResult[] {
    if (this.buffer.length === 0) return [];
    const result = parseClaudeStreamLine(this.buffer, this.context);
    this.buffer = '';
    return [result];
  }
}

const DEFAULT_SOURCE: EventSource = {
  provider: 'claude',
  client: 'claude-code',
  environment: process.platform,
  adapter: 'claude-code',
};

export function parseClaudeStreamLine(
  line: string,
  context: ClaudeParserContext,
): ClaudeParseResult {
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
  const events = parseMessage(value, context.sessionId, timestamp, source);
  return { events, ignored: events.length === 0 };
}

function parseMessage(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): readonly AgentEvent[] {
  switch (message.type) {
    case 'system':
      return message.subtype === 'init'
        ? [
            event('session_started', sessionId, timestamp, source, {
              ...(typeof message.session_id === 'string'
                ? { providerSessionId: message.session_id }
                : {}),
            }),
          ]
        : [];
    case 'assistant':
      return parseAssistant(message, sessionId, timestamp, source);
    case 'user':
      return parseToolResults(message, sessionId, timestamp, source);
    case 'result':
      return [
        event('session_finished', sessionId, timestamp, source, {
          reason: message.is_error === true ? 'failed' : 'completed',
          ...(typeof message.subtype === 'string' ? { providerOutcome: message.subtype } : {}),
        }),
      ];
    default:
      return [];
  }
}

function parseAssistant(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): readonly AgentEvent[] {
  const content = getContent(message);
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push(
        event('tool_call_started', sessionId, timestamp, source, {
          toolName: block.name,
          ...(typeof block.id === 'string' ? { toolCallId: block.id } : {}),
        }),
      );
    } else if (block.type === 'text') {
      events.push(
        event('agent_message', sessionId, timestamp, source, { summary: 'assistant message' }),
      );
    }
  }
  return events;
}

function parseToolResults(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): readonly AgentEvent[] {
  return getContent(message)
    .filter((block) => block.type === 'tool_result')
    .map((block) =>
      event('tool_call_finished', sessionId, timestamp, source, {
        toolName: 'unknown',
        success: block.is_error !== true,
      }),
    );
}

function getContent(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  const nested = isRecord(message.message) ? message.message.content : message.content;
  if (!Array.isArray(nested)) return [];
  return nested.filter(isRecord);
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
