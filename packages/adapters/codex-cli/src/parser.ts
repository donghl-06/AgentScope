import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentEventType,
  EventSource,
  ProviderEventPayload,
  UsageSnapshot,
} from '@agentscope/protocol';

export interface CodexParserContext {
  readonly sessionId: string;
  readonly timestamp?: number;
  readonly source?: EventSource;
  /**
   * Classify a provider command without retaining its raw text in an event.
   * The callback is intentionally optional so the adapter remains usable as a
   * standalone parser with the conservative `command` fallback.
   */
  readonly classifyCommand?: (commandName: string) => CodexCommandKind;
}

export type CodexCommandKind = 'test' | 'build' | 'lint' | 'typecheck' | 'command';

export interface CodexParseResult {
  readonly events: readonly AgentEvent[];
  readonly ignored: boolean;
  readonly malformed?: boolean;
}

export class CodexStreamDecoder {
  private buffer = '';
  private readonly toolCalls = new Map<string, ToolCallState>();

  constructor(private readonly context: CodexParserContext) {}

  push(chunk: string): CodexParseResult[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => parseCodexLine(line, this.context, this.toolCalls));
  }

  flush(): CodexParseResult[] {
    if (this.buffer.length === 0) return [];
    const result = parseCodexLine(this.buffer, this.context, this.toolCalls);
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
  return parseCodexLine(line, context, new Map());
}

interface ToolCallState {
  readonly toolName: string;
  readonly startedAt: number;
}

function parseCodexLine(
  line: string,
  context: CodexParserContext,
  toolCalls: Map<string, ToolCallState>,
): CodexParseResult {
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
  const events = parseRecord(value, context, timestamp, source, toolCalls);
  return { events, ignored: events.length === 0 };
}

function parseRecord(
  record: Record<string, unknown>,
  context: CodexParserContext,
  timestamp: number,
  source: EventSource,
  toolCalls: Map<string, ToolCallState>,
): readonly AgentEvent[] {
  const { sessionId } = context;
  const provider = providerEvent(record, sessionId, timestamp, source);
  switch (record.type) {
    case 'thread.started':
      return [
        event('session_started', sessionId, timestamp, source, {
          ...(typeof record.thread_id === 'string' ? { providerSessionId: record.thread_id } : {}),
        }),
        provider,
      ];
    case 'turn.started':
      return [event('planning', sessionId, timestamp, source, {}), provider];
    case 'item.started':
      return [
        ...parseItem(record.item, context, timestamp, source, 'started', toolCalls),
        provider,
      ];
    case 'item.completed':
      return [
        ...parseItem(record.item, context, timestamp, source, 'completed', toolCalls),
        provider,
      ];
    case 'turn.completed': {
      const usage = normalizeUsage(record.usage);
      return [
        ...(usage === undefined
          ? []
          : [event('usage_updated', sessionId, timestamp, source, { usage })]),
        event('session_finished', sessionId, timestamp, source, { reason: 'completed' }),
        provider,
      ];
    }
    default:
      return [provider];
  }
}

function parseItem(
  value: unknown,
  context: CodexParserContext,
  timestamp: number,
  source: EventSource,
  phase: 'started' | 'completed',
  toolCalls: Map<string, ToolCallState>,
): readonly AgentEvent[] {
  const { sessionId } = context;
  if (!isRecord(value) || typeof value.type !== 'string') return [];
  if (value.type === 'agent_message' && phase === 'completed') {
    return [event('agent_message', sessionId, timestamp, source, { summary: 'agent message' })];
  }
  if (value.type !== 'command_execution') return [];
  const toolCallId = typeof value.id === 'string' ? value.id : undefined;
  const toolName = 'command_execution';
  const rawCommand = stringValue(value.command);
  const commandKind =
    rawCommand === undefined ? 'command' : (context.classifyCommand?.(rawCommand) ?? 'command');
  if (phase === 'started') {
    if (toolCallId !== undefined) toolCalls.set(toolCallId, { toolName, startedAt: timestamp });
    return [
      event('tool_call_started', sessionId, timestamp, source, {
        toolName,
        ...(toolCallId === undefined ? {} : { toolCallId }),
      }),
      event('command_started', sessionId, timestamp, source, {
        commandKind,
        commandName: commandKind === 'command' ? 'command execution' : commandKind,
      }),
    ];
  }
  const exitCode =
    typeof value.exit_code === 'number' ? value.exit_code : value.status === 'completed' ? 0 : 1;
  const success = exitCode === 0 && value.status !== 'failed';
  const active = toolCallId === undefined ? undefined : toolCalls.get(toolCallId);
  if (toolCallId !== undefined) toolCalls.delete(toolCallId);
  return [
    event('tool_call_finished', sessionId, timestamp, source, {
      toolName: active?.toolName ?? toolName,
      success,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(active === undefined ? {} : { durationMs: Math.max(0, timestamp - active.startedAt) }),
      ...(success ? {} : { errorCode: 'provider_tool_error' }),
    }),
    event('command_finished', sessionId, timestamp, source, {
      commandKind: 'command',
      exitCode,
    }),
  ];
}

function providerEvent(
  record: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): AgentEvent {
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  const phase = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : undefined;
  const item = isRecord(record.item) ? record.item : undefined;
  const itemType = item === undefined ? undefined : stringValue(item.type);
  const itemId = item === undefined ? undefined : stringValue(item.id);
  const metadata: Record<string, string | number | boolean> = {};
  if (itemType !== undefined) metadata.itemType = itemType;
  if (itemId !== undefined) metadata.itemId = itemId;
  const status = item === undefined ? stringValue(record.status) : stringValue(item.status);
  if (status !== undefined) metadata.status = status;
  const exitCode = item === undefined ? numberValue(record.exit_code) : numberValue(item.exit_code);
  if (exitCode !== undefined) metadata.exitCode = exitCode;
  const usage = normalizeUsage(record.usage);
  if (usage?.inputTokens !== undefined) metadata.inputTokens = usage.inputTokens;
  if (usage?.outputTokens !== undefined) metadata.outputTokens = usage.outputTokens;
  if (usage?.reasoningTokens !== undefined) metadata.reasoningTokens = usage.reasoningTokens;
  const payload: ProviderEventPayload = {
    providerEventType: type,
    ...(phase === undefined ? {} : { phase }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
  return event('provider_event', sessionId, timestamp, source, payload);
}

function normalizeUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberValue(value.input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  const cachedInputTokens = numberValue(value.cached_input_tokens);
  const reasoningTokens = numberValue(value.reasoning_output_tokens);
  const turnCount = numberValue(value.turn_count);
  const totalTokens =
    numberValue(value.total_tokens) ??
    (inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens);
  const usage: UsageSnapshot = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cacheReadInputTokens: cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(turnCount === undefined ? {} : { turnCount }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
