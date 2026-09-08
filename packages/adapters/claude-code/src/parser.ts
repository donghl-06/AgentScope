import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  EventSource,
  ProviderEventPayload,
  ProviderInfoPayload,
  UsageSnapshot,
} from '@agentscope/protocol';

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

interface ToolCallState {
  readonly toolName: string;
  readonly startedAt: number;
}

export class ClaudeStreamDecoder {
  private buffer = '';
  private readonly toolCalls = new Map<string, ToolCallState>();

  constructor(private readonly context: ClaudeParserContext) {}

  push(chunk: string): ClaudeParseResult[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => parseClaudeLine(line, this.context, this.toolCalls));
  }

  flush(): ClaudeParseResult[] {
    if (this.buffer.length === 0) return [];
    const result = parseClaudeLine(this.buffer, this.context, this.toolCalls);
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

/** Parse one redacted Claude JSONL record into provider-neutral events. */
export function parseClaudeStreamLine(
  line: string,
  context: ClaudeParserContext,
): ClaudeParseResult {
  return parseClaudeLine(line, context, new Map());
}

function parseClaudeLine(
  line: string,
  context: ClaudeParserContext,
  toolCalls: Map<string, ToolCallState>,
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
  const events = parseMessage(value, context.sessionId, timestamp, source, toolCalls);
  return { events, ignored: events.length === 0 };
}

function parseMessage(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  toolCalls: Map<string, ToolCallState>,
): readonly AgentEvent[] {
  switch (message.type) {
    case 'system':
      return parseSystem(message, sessionId, timestamp, source);
    case 'assistant':
      return parseAssistant(message, sessionId, timestamp, source, toolCalls);
    case 'user':
      return parseToolResults(message, sessionId, timestamp, source, toolCalls);
    case 'result':
      return parseResult(message, sessionId, timestamp, source);
    case 'stream_event':
      return parseStreamEvent(message, sessionId, timestamp, source, toolCalls);
    default: {
      const milestone = parseMilestone(message, sessionId, timestamp, source);
      if (milestone !== undefined) {
        return [milestone, providerEvent(message, sessionId, timestamp, source)];
      }
      // Preserve future Claude records as safe metadata rather than retaining content.
      return [providerEvent(message, sessionId, timestamp, source)];
    }
  }
}

function parseSystem(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): readonly AgentEvent[] {
  if (message.subtype === 'init') {
    const providerSessionId = stringValue(message.session_id);
    const events: AgentEvent[] = [
      event('session_started', sessionId, timestamp, source, {
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
      }),
    ];
    const info = providerInfo(message);
    if (Object.keys(info).length > 0) {
      events.push(event('provider_info', sessionId, timestamp, source, info));
    }
    events.push(providerEvent(message, sessionId, timestamp, source));
    return events;
  }

  if (message.subtype === 'thinking_tokens') {
    const estimatedTokens = numberValue(message.estimated_tokens);
    const estimatedTokensDelta = numberValue(message.estimated_tokens_delta);
    const events: AgentEvent[] = [];
    if (estimatedTokens !== undefined || estimatedTokensDelta !== undefined) {
      events.push(
        event('usage_updated', sessionId, timestamp, source, {
          usage: {
            ...(estimatedTokens === undefined ? {} : { thinkingTokens: estimatedTokens }),
            ...(estimatedTokensDelta === undefined
              ? {}
              : { thinkingTokensDelta: estimatedTokensDelta }),
          },
        }),
      );
    }
    const milestone = parseMilestone(message, sessionId, timestamp, source);
    if (milestone !== undefined) events.push(milestone);
    events.push(providerEvent(message, sessionId, timestamp, source));
    return events;
  }

  const milestone = parseMilestone(message, sessionId, timestamp, source);
  return milestone === undefined
    ? [providerEvent(message, sessionId, timestamp, source)]
    : [milestone, providerEvent(message, sessionId, timestamp, source)];
}

function parseMilestone(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): AgentEvent | undefined {
  const candidate =
    stringValue(message.milestone_event) ??
    stringValue(message.subtype) ??
    stringValue(message.type);
  const eventType =
    candidate === 'milestone_started' || candidate === 'milestone_completed'
      ? candidate
      : undefined;
  if (eventType === undefined) return undefined;
  const milestoneId =
    stringValue(message.milestone_id) ??
    stringValue(message.milestoneId) ??
    stringValue(message.id);
  if (milestoneId === undefined) return undefined;
  const title = stringValue(message.title) ?? stringValue(message.milestone_title);
  return event(eventType, sessionId, timestamp, source, {
    milestoneId,
    ...(title === undefined ? {} : { title }),
  });
}

function parseAssistant(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  toolCalls: Map<string, ToolCallState>,
): readonly AgentEvent[] {
  const assistant = isRecord(message.message) ? message.message : message;
  const content = getContent(assistant);
  const events: AgentEvent[] = [];
  const usage = normalizeUsage(assistant.usage);
  if (usage !== undefined) {
    events.push(event('usage_updated', sessionId, timestamp, source, { usage }));
  }

  for (const block of content) {
    if (block.type === 'tool_use') {
      const toolName = stringValue(block.name) ?? 'unknown';
      const toolCallId = stringValue(block.id);
      if (trackToolCall(toolCalls, toolCallId, toolName, timestamp)) {
        events.push(
          event('tool_call_started', sessionId, timestamp, source, {
            toolName,
            ...(toolCallId === undefined ? {} : { toolCallId }),
          }),
        );
      }
    } else if (block.type === 'thinking') {
      events.push(
        event('planning', sessionId, timestamp, source, { summary: 'provider thinking' }),
      );
    } else if (block.type === 'text') {
      events.push(
        event('agent_message', sessionId, timestamp, source, { summary: 'assistant message' }),
      );
    }
  }

  events.push(
    providerEvent(message, sessionId, timestamp, source, {
      metadata: { contentBlockCount: content.length },
    }),
  );
  return events;
}

function parseToolResults(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  toolCalls: Map<string, ToolCallState>,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of getContent(message)) {
    if (block.type !== 'tool_result') continue;
    const toolCallId = stringValue(block.tool_use_id);
    const active = toolCallId === undefined ? undefined : toolCalls.get(toolCallId);
    const success = block.is_error !== true;
    events.push(
      event('tool_call_finished', sessionId, timestamp, source, {
        toolName: active?.toolName ?? 'unknown',
        success,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(active === undefined ? {} : { durationMs: Math.max(0, timestamp - active.startedAt) }),
        ...(success ? {} : { errorCode: 'provider_tool_error' }),
      }),
    );
    if (toolCallId !== undefined) toolCalls.delete(toolCallId);
  }
  if (events.length > 0) {
    events.push(
      providerEvent(message, sessionId, timestamp, source, {
        metadata: { toolResultCount: events.length },
      }),
    );
  }
  return events;
}

function trackToolCall(
  toolCalls: Map<string, ToolCallState>,
  toolCallId: string | undefined,
  toolName: string,
  timestamp: number,
): boolean {
  if (toolCallId === undefined) return true;
  if (toolCalls.has(toolCallId)) return false;
  toolCalls.set(toolCallId, { toolName, startedAt: timestamp });
  return true;
}

function parseResult(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  const usage = normalizeResultUsage(message);
  if (usage !== undefined) {
    events.push(event('usage_updated', sessionId, timestamp, source, { usage }));
  }
  events.push(providerEvent(message, sessionId, timestamp, source));
  events.push(
    event('session_finished', sessionId, timestamp, source, {
      reason: message.is_error === true ? 'failed' : 'completed',
      ...(typeof message.subtype === 'string' ? { providerOutcome: message.subtype } : {}),
    }),
  );
  return events;
}

function parseStreamEvent(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  toolCalls: Map<string, ToolCallState>,
): readonly AgentEvent[] {
  const nested = isRecord(message.event) ? message.event : undefined;
  if (nested === undefined || typeof nested.type !== 'string') {
    return [providerEvent(message, sessionId, timestamp, source)];
  }

  const events: AgentEvent[] = [
    providerEvent(message, sessionId, timestamp, source, {
      phase: nested.type,
      metadata: metadataFromRecord(nested),
    }),
  ];
  const nestedMessage = isRecord(nested.message) ? nested.message : undefined;
  const usage = normalizeUsage(
    nestedMessage?.usage ?? (nested.type === 'message_delta' ? nested.usage : undefined),
  );
  if (usage !== undefined) {
    events.unshift(event('usage_updated', sessionId, timestamp, source, { usage }));
  }

  if (nested.type === 'content_block_start' && isRecord(nested.content_block)) {
    const block = nested.content_block;
    if (block.type === 'tool_use') {
      const toolName = stringValue(block.name) ?? 'unknown';
      const toolCallId = stringValue(block.id);
      if (trackToolCall(toolCalls, toolCallId, toolName, timestamp)) {
        events.push(
          event('tool_call_started', sessionId, timestamp, source, {
            toolName,
            ...(toolCallId === undefined ? {} : { toolCallId }),
          }),
        );
      }
    }
  }
  return events;
}

function providerInfo(message: Record<string, unknown>): ProviderInfoPayload {
  const capabilities = Array.isArray(message.capabilities)
    ? message.capabilities.filter((value): value is string => typeof value === 'string')
    : undefined;
  const providerSessionId = stringValue(message.session_id);
  const model = stringValue(message.model);
  const cliVersion = stringValue(message.claude_code_version);
  const permissionMode = stringValue(message.permissionMode);
  const outputFormat = stringValue(message.output_format);
  return {
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(model === undefined ? {} : { model }),
    ...(cliVersion === undefined ? {} : { cliVersion }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    ...(capabilities === undefined || capabilities.length === 0
      ? {}
      : { capabilityLabels: capabilities }),
    ...countIfPresent(message.tools, 'toolCount'),
    ...countIfPresent(message.mcp_servers, 'mcpServerCount'),
    ...countIfPresent(message.slash_commands, 'slashCommandCount'),
    ...countIfPresent(message.agents, 'agentCount'),
    ...countIfPresent(message.skills, 'skillCount'),
    ...countIfPresent(message.plugins, 'pluginCount'),
  };
}

function countIfPresent(value: unknown, key: string): Record<string, number> {
  return Array.isArray(value) ? { [key]: value.length } : {};
}

function providerEvent(
  message: Record<string, unknown>,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  options: {
    readonly phase?: string;
    readonly metadata?: Record<string, string | number | boolean>;
  } = {},
): AgentEvent {
  const hookName = stringValue(message.hook_event_name);
  const subtype = stringValue(message.subtype);
  const metadata = options.metadata ?? metadataFromRecord(message);
  const payload: ProviderEventPayload = {
    providerEventType: stringValue(message.type) ?? 'unknown',
    ...(subtype === undefined ? {} : { subtype }),
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    ...(hookName === undefined ? {} : { name: hookName }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
  return event('provider_event', sessionId, timestamp, source, payload);
}

function normalizeResultUsage(message: Record<string, unknown>): UsageSnapshot | undefined {
  const base = normalizeUsage(message.usage) ?? normalizeModelUsage(message.modelUsage);
  const durationMs = numberValue(message.duration_ms);
  const durationApiMs = numberValue(message.duration_api_ms);
  const ttftMs = numberValue(message.ttft_ms);
  const ttftStreamMs = numberValue(message.ttft_stream_ms);
  const timeToRequestMs = numberValue(message.time_to_request_ms);
  const firstContentFrameMs = numberValue(message.first_content_frame_ms);
  const queuedTurnCount = numberValue(message.queued_turn_count);
  const totalCostUsd = numberValue(message.total_cost_usd);
  const iterations = numberValue(message.iterations);
  const inferenceGeo = stringValue(message.inference_geo);
  const speed = stringValue(message.speed);
  const model = stringValue(message.model);
  const timing: UsageSnapshot = {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(durationApiMs === undefined ? {} : { durationApiMs }),
    ...(ttftMs === undefined ? {} : { ttftMs }),
    ...(ttftStreamMs === undefined ? {} : { ttftStreamMs }),
    ...(timeToRequestMs === undefined ? {} : { timeToRequestMs }),
    ...(firstContentFrameMs === undefined ? {} : { firstContentFrameMs }),
    ...(queuedTurnCount === undefined ? {} : { queuedTurnCount }),
    ...(iterations === undefined ? {} : { iterations }),
    ...(inferenceGeo === undefined ? {} : { inferenceGeo }),
    ...(speed === undefined ? {} : { speed }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(model === undefined ? {} : { model }),
  };
  const merged = { ...base, ...timing };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function normalizeModelUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const snapshots = Object.values(value)
    .filter(isRecord)
    .map((item) => normalizeUsage(item))
    .filter((item): item is UsageSnapshot => item !== undefined);
  if (snapshots.length === 0) return undefined;
  const sum = (key: keyof UsageSnapshot): number | undefined => {
    const values = snapshots
      .map((snapshot) => snapshot[key])
      .filter((item): item is number => typeof item === 'number');
    return values.length === 0 ? undefined : values.reduce((total, item) => total + item, 0);
  };
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const cacheCreationInputTokens = sum('cacheCreationInputTokens');
  const cacheReadInputTokens = sum('cacheReadInputTokens');
  const cacheCreation5mInputTokens = sum('cacheCreation5mInputTokens');
  const cacheCreation1hInputTokens = sum('cacheCreation1hInputTokens');
  const thinkingTokens = sum('thinkingTokens');
  const reasoningTokens = sum('reasoningTokens');
  const serverToolUseRequests = sum('serverToolUseRequests');
  const totalTokens = sum('totalTokens');
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheCreation5mInputTokens === undefined ? {} : { cacheCreation5mInputTokens }),
    ...(cacheCreation1hInputTokens === undefined ? {} : { cacheCreation1hInputTokens }),
    ...(thinkingTokens === undefined ? {} : { thinkingTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(serverToolUseRequests === undefined ? {} : { serverToolUseRequests }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function normalizeUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const cacheCreation = isRecord(value.cache_creation) ? value.cache_creation : undefined;
  const outputDetails = isRecord(value.output_tokens_details)
    ? value.output_tokens_details
    : undefined;
  const serverToolUse = isRecord(value.server_tool_use) ? value.server_tool_use : undefined;
  const inputTokens = numberValue(value.input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  const totalTokens =
    numberValue(value.total_tokens) ??
    (inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens);
  const cacheCreationInputTokens = numberValue(value.cache_creation_input_tokens);
  const cacheReadInputTokens = numberValue(value.cache_read_input_tokens);
  const cacheCreation5mInputTokens = numberValue(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheCreation1hInputTokens = numberValue(cacheCreation?.ephemeral_1h_input_tokens);
  const thinkingTokens = numberValue(value.thinking_tokens);
  const reasoningTokens = numberValue(outputDetails?.reasoning_tokens);
  const serverToolUseRequests = sumRecordNumbers(serverToolUse);
  const iterations = numberValue(value.iterations);
  const inferenceGeo = stringValue(value.inference_geo);
  const speed = stringValue(value.speed);
  const serviceTier = stringValue(value.service_tier);
  const usage: UsageSnapshot = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheCreation5mInputTokens === undefined ? {} : { cacheCreation5mInputTokens }),
    ...(cacheCreation1hInputTokens === undefined ? {} : { cacheCreation1hInputTokens }),
    ...(thinkingTokens === undefined ? {} : { thinkingTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(serverToolUseRequests === undefined ? {} : { serverToolUseRequests }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(iterations === undefined ? {} : { iterations }),
    ...(inferenceGeo === undefined ? {} : { inferenceGeo }),
    ...(speed === undefined ? {} : { speed }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function sumRecordNumbers(value: Record<string, unknown> | undefined): number | undefined {
  if (value === undefined) return undefined;
  const numbers = Object.values(value).filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0,
  );
  return numbers.length === 0 ? undefined : numbers.reduce((total, item) => total + item, 0);
}

function metadataFromRecord(
  record: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const allowed = [
    'index',
    'status',
    'stop_reason',
    'is_error',
    'num_turns',
    'duration_ms',
    'duration_api_ms',
    'ttft_ms',
    'ttft_stream_ms',
    'time_to_request_ms',
    'first_content_frame_ms',
    'total_cost_usd',
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'thinking_tokens',
    'estimated_tokens',
    'estimated_tokens_delta',
    'exit_code',
    'queued_turn_count',
    'iterations',
    'inference_geo',
    'speed',
    'service_tier',
  ];
  const metadata: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'boolean') metadata[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) metadata[key] = value;
  }
  return metadata;
}

function getContent(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  const content = isRecord(message.message) ? message.message.content : message.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function event(
  type: AgentEvent['type'],
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
