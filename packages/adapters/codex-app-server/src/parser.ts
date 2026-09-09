import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  EventSource,
  ProviderEventPayload,
  UsageSnapshot,
} from '@agentscope/protocol';

export interface CodexAppServerParserOptions {
  readonly sessionId: string;
  readonly now?: () => number;
  readonly source?: EventSource;
  readonly classifyCommand?: (commandName: string) => CodexAppServerCommandKind;
}

export type CodexAppServerCommandKind = 'test' | 'build' | 'lint' | 'typecheck' | 'command';

export interface AppServerMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface CodexAppServerParseResult {
  readonly events: readonly AgentEvent[];
  readonly ignored: boolean;
  readonly malformed?: boolean;
  readonly message?: AppServerMessage;
}

const DEFAULT_SOURCE: EventSource = {
  provider: 'codex',
  client: 'codex-app-server',
  environment: process.platform,
  adapter: 'codex-app-server',
};

export class CodexAppServerStreamDecoder {
  private buffer = '';
  private readonly parser: CodexAppServerEventParser;

  constructor(options: CodexAppServerParserOptions) {
    this.parser = new CodexAppServerEventParser(options);
  }

  push(chunk: string): CodexAppServerParseResult[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => this.parser.parseLine(line));
  }

  flush(): CodexAppServerParseResult[] {
    if (this.buffer.length === 0) return [];
    const result = this.parser.parseLine(this.buffer);
    this.buffer = '';
    return [result];
  }
}

export function parseCodexAppServerLine(
  line: string,
  options: CodexAppServerParserOptions,
): CodexAppServerParseResult {
  return new CodexAppServerEventParser(options).parseLine(line);
}

class CodexAppServerEventParser {
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly source: EventSource;
  private readonly classifyCommand:
    ((commandName: string) => CodexAppServerCommandKind) | undefined;
  private sequence = 0;
  private readonly activeTools = new Map<
    string,
    { readonly toolName: string; readonly startedAt: number }
  >();
  private startedTurns = new Set<string>();

  constructor(options: CodexAppServerParserOptions) {
    this.sessionId = options.sessionId;
    this.now = options.now ?? Date.now;
    this.source = options.source ?? DEFAULT_SOURCE;
    this.classifyCommand = options.classifyCommand;
  }

  parseLine(line: string): CodexAppServerParseResult {
    const trimmed = line.trim();
    if (trimmed.length === 0) return { events: [], ignored: true };
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { events: [], ignored: false, malformed: true };
    }
    if (!isRecord(value)) return { events: [], ignored: true };
    const message = value as AppServerMessage;
    if (typeof message.method !== 'string') return { events: [], ignored: true, message };
    const timestamp = this.timestamp(message.params);
    const events = this.parseNotification(message.method, message.params, timestamp);
    return { events, ignored: events.length === 0, message };
  }

  private parseNotification(
    method: string,
    params: unknown,
    timestamp: number,
  ): readonly AgentEvent[] {
    const value = isRecord(params) ? params : {};
    const base = [this.providerEvent(method, value, timestamp)];
    switch (method) {
      case 'thread/started':
        return base;
      case 'thread/status/changed':
        return [...base, ...this.statusEvents(value, timestamp)];
      case 'turn/started':
        return [...base, this.turnStarted(value, timestamp)];
      case 'turn/completed':
        return [...base, this.turnFinished(value, timestamp)];
      case 'item/started':
        return [...base, ...this.itemEvents(value, 'started', timestamp)];
      case 'item/completed':
        return [...base, ...this.itemEvents(value, 'completed', timestamp)];
      case 'thread/tokenUsage/updated':
        return [...base, ...this.usageEvents(value, timestamp)];
      case 'turn/plan/updated':
      case 'plan/delta':
        return [...base, this.planningEvent(value, timestamp)];
      case 'error':
        return [...base, ...this.errorEvents(value, timestamp)];
      default:
        return base;
    }
  }

  private turnStarted(params: Record<string, unknown>, timestamp: number): AgentEvent {
    const turn = recordValue(params.turn);
    const turnId =
      stringValue(turn?.id) ?? stringValue(params.turnId) ?? `turn-${this.sequence + 1}`;
    this.startedTurns.add(turnId);
    this.sequence += 1;
    return event('turn_started', this.sessionId, timestamp, this.source, {
      turnId,
      sequence: this.sequence,
      providerTurnId: turnId,
      title: `turn ${this.sequence}`,
    });
  }

  private turnFinished(params: Record<string, unknown>, timestamp: number): AgentEvent {
    const turn = recordValue(params.turn);
    const turnId =
      stringValue(params.turnId) ?? stringValue(turn?.id) ?? `turn-${this.sequence || 1}`;
    const status = stringValue(turn?.status);
    const reason =
      status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed';
    return event('turn_finished', this.sessionId, timestamp, this.source, {
      turnId,
      reason,
      ...(status === undefined ? {} : { providerOutcome: status }),
    });
  }

  private statusEvents(params: Record<string, unknown>, timestamp: number): readonly AgentEvent[] {
    const status = recordValue(params.status);
    const type = stringValue(status?.type);
    const turnId = stringValue(params.turnId);
    if (type !== 'active') {
      if (type === 'idle') return [];
      if (turnId === undefined) return [];
      return [
        event('turn_updated', this.sessionId, timestamp, this.source, {
          turnId,
          status: type === 'systemError' ? 'blocked' : 'waiting',
        }),
      ];
    }
    const flags = arrayValue(status?.activeFlags).filter(
      (value): value is string => typeof value === 'string',
    );
    if (flags.includes('waitingOnApproval')) {
      return [
        event('blocked', this.sessionId, timestamp, this.source, {
          reason: 'waiting for approval',
        }),
        ...(turnId === undefined
          ? []
          : [
              event('turn_updated', this.sessionId, timestamp, this.source, {
                turnId,
                status: 'blocked',
              }),
            ]),
      ];
    }
    if (flags.includes('waitingOnUserInput')) {
      return [
        ...(turnId === undefined
          ? []
          : [
              event('turn_updated', this.sessionId, timestamp, this.source, {
                turnId,
                status: 'waiting',
              }),
            ]),
      ];
    }
    return [];
  }

  private itemEvents(
    params: Record<string, unknown>,
    phase: 'started' | 'completed',
    timestamp: number,
  ): readonly AgentEvent[] {
    const item = recordValue(params.item);
    if (item === undefined) return [];
    const itemType = stringValue(item.type) ?? 'unknown';
    const itemId = stringValue(item.id);
    const toolCallId = itemId;
    if (itemType === 'commandExecution') {
      const command = stringValue(item.command);
      const commandKind =
        command === undefined ? 'command' : (this.classifyCommand?.(command) ?? 'command');
      if (phase === 'started') {
        if (toolCallId !== undefined)
          this.activeTools.set(toolCallId, { toolName: 'command_execution', startedAt: timestamp });
        return [
          event('tool_call_started', this.sessionId, timestamp, this.source, {
            toolName: 'command_execution',
            ...(toolCallId === undefined ? {} : { toolCallId }),
          }),
          event('command_started', this.sessionId, timestamp, this.source, {
            commandKind,
            commandName: commandKind === 'command' ? 'command execution' : commandKind,
          }),
        ];
      }
      const active = toolCallId === undefined ? undefined : this.activeTools.get(toolCallId);
      if (toolCallId !== undefined) this.activeTools.delete(toolCallId);
      const exitCode =
        numberValue(item.exitCode) ??
        numberValue(item.exit_code) ??
        (stringValue(item.status) === 'completed' ? 0 : 1);
      const success = exitCode === 0 && stringValue(item.status) !== 'failed';
      return [
        event('tool_call_finished', this.sessionId, timestamp, this.source, {
          toolName: active?.toolName ?? 'command_execution',
          success,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...(active === undefined
            ? {}
            : { durationMs: Math.max(0, timestamp - active.startedAt) }),
          ...(success ? {} : { errorCode: 'provider_tool_error' }),
        }),
        event('command_finished', this.sessionId, timestamp, this.source, {
          commandKind,
          exitCode,
        }),
      ];
    }
    if (itemType === 'fileChange' && phase === 'completed') {
      return fileChangeEvents(this.sessionId, this.source, item, timestamp);
    }
    if (itemType === 'plan') {
      const milestoneId = itemId ?? `plan-${this.sequence || 1}`;
      const title =
        stringValue(item.name) ?? stringValue(item.title) ?? `Codex plan ${this.sequence || 1}`;
      return [
        event(
          phase === 'started' ? 'milestone_started' : 'milestone_completed',
          this.sessionId,
          timestamp,
          this.source,
          {
            milestoneId,
            title,
          },
        ),
      ];
    }
    if (itemType === 'agentMessage' && phase === 'completed') {
      return [
        event('agent_message', this.sessionId, timestamp, this.source, {
          summary: 'agent message',
        }),
      ];
    }
    if (itemType === 'reasoning' && phase === 'started') {
      return [event('planning', this.sessionId, timestamp, this.source, {})];
    }
    if (phase === 'started' && isToolItem(itemType)) {
      if (toolCallId !== undefined)
        this.activeTools.set(toolCallId, { toolName: itemType, startedAt: timestamp });
      return [
        event('tool_call_started', this.sessionId, timestamp, this.source, {
          toolName: itemType,
          ...(toolCallId === undefined ? {} : { toolCallId }),
        }),
      ];
    }
    if (phase === 'completed' && isToolItem(itemType)) {
      const active = toolCallId === undefined ? undefined : this.activeTools.get(toolCallId);
      if (toolCallId !== undefined) this.activeTools.delete(toolCallId);
      const success = stringValue(item.status) !== 'failed';
      return [
        event('tool_call_finished', this.sessionId, timestamp, this.source, {
          toolName: active?.toolName ?? itemType,
          success,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...(active === undefined
            ? {}
            : { durationMs: Math.max(0, timestamp - active.startedAt) }),
          ...(success ? {} : { errorCode: 'provider_tool_error' }),
        }),
      ];
    }
    return [];
  }

  private usageEvents(params: Record<string, unknown>, timestamp: number): readonly AgentEvent[] {
    const usage = recordValue(params.tokenUsage);
    const total = recordValue(usage?.total);
    if (total === undefined) return [];
    const normalized: UsageSnapshot = {
      ...numberProperty(total, 'inputTokens'),
      ...numberProperty(total, 'outputTokens'),
      ...numberProperty(total, 'cachedInputTokens', 'cacheReadInputTokens'),
      ...numberProperty(total, 'reasoningOutputTokens', 'reasoningTokens'),
      ...numberProperty(total, 'totalTokens'),
    };
    return Object.keys(normalized).length === 0
      ? []
      : [event('usage_updated', this.sessionId, timestamp, this.source, { usage: normalized })];
  }

  private planningEvent(params: Record<string, unknown>, timestamp: number): AgentEvent {
    const delta = stringValue(params.delta);
    return event('planning', this.sessionId, timestamp, this.source, {
      ...(delta === undefined ? {} : { summary: 'Codex plan updated' }),
    });
  }

  private errorEvents(params: Record<string, unknown>, timestamp: number): readonly AgentEvent[] {
    const willRetry = params.willRetry === true;
    const error = recordValue(params.error);
    const message = stringValue(error?.message) ?? 'Codex app-server reported an error.';
    return willRetry
      ? []
      : [
          event('error', this.sessionId, timestamp, this.source, {
            code: 'provider_error',
            message,
          }),
        ];
  }

  private providerEvent(
    method: string,
    params: Record<string, unknown>,
    timestamp: number,
  ): AgentEvent {
    const metadata: Record<string, string | number | boolean> = {};
    const item = recordValue(params.item);
    const itemType = stringValue(item?.type);
    const turnId = stringValue(params.turnId);
    if (itemType !== undefined) metadata.itemType = itemType;
    if (turnId !== undefined) metadata.turnId = turnId;
    const providerEvent: ProviderEventPayload = {
      providerEventType: method,
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
    return event('provider_event', this.sessionId, timestamp, this.source, providerEvent);
  }

  private timestamp(params: unknown): number {
    const record = isRecord(params) ? params : undefined;
    const candidate = numberValue(record?.completedAtMs) ?? numberValue(record?.startedAtMs);
    if (candidate !== undefined) return candidate;
    return this.now();
  }
}

function fileChangeEvents(
  sessionId: string,
  source: EventSource,
  item: Record<string, unknown>,
  timestamp: number,
): AgentEvent[] {
  const changes = arrayValue(item.changes);
  const events: AgentEvent[] = [];
  for (const change of changes) {
    const path = stringValue(recordValue(change)?.path);
    if (path !== undefined)
      events.push(event('file_write', sessionId, timestamp, source, { path }));
  }
  return events;
}

function isToolItem(type: string): boolean {
  return (
    type === 'mcpToolCall' ||
    type === 'dynamicToolCall' ||
    type === 'collabAgentToolCall' ||
    type === 'webSearch' ||
    type === 'imageGeneration' ||
    type === 'computerScreenshot' ||
    type === 'applyPatch'
  );
}

function numberProperty(
  record: Record<string, unknown>,
  source: string,
  target = source,
): Record<string, number> {
  const value = numberValue(record[source]);
  return value === undefined ? {} : { [target]: value };
}

function event<T extends AgentEvent['type']>(
  type: T,
  sessionId: string,
  timestamp: number,
  source: EventSource,
  payload: unknown,
): AgentEvent {
  return { id: randomUUID(), sessionId, timestamp, source, type, payload, confidence: 0.95 };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
