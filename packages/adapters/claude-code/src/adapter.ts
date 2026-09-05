import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  AgentCapabilities,
  AttachedSession,
  AdapterDetectContext,
  DetectionResult,
  StartAgentRequest,
} from '@agentscope/adapter-base';
import type { AgentEvent, EventSource } from '@agentscope/protocol';

import { ClaudeStreamDecoder } from './parser.js';
import type { parseClaudeStreamLine } from './parser.js';

export interface ClaudeCodeAdapterOptions {
  readonly executable?: string;
  readonly now?: () => number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

const CAPABILITIES: AgentCapabilities = {
  structuredEvents: true,
  toolCalls: true,
  fileEvents: false,
  commandEvents: true,
  tokenUsage: false,
  sessionInfo: true,
  milestones: false,
};

const SOURCE: EventSource = {
  provider: 'claude',
  client: 'claude-code',
  environment: process.platform,
  adapter: 'claude-code',
};

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  private readonly executable: string;
  private readonly now: () => number;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly onStderr: ((chunk: string) => void) | undefined;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.executable = options.executable ?? 'claude';
    this.now = options.now ?? Date.now;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
  }

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async detect(context: AdapterDetectContext): Promise<DetectionResult> {
    const executable = context.executablePath ?? this.executable;
    return detectExecutable(executable, context.workspacePath);
  }

  async start(request: StartAgentRequest): Promise<AttachedSession> {
    const child = spawn(this.executable, [...request.args], {
      cwd: request.workspacePath,
      env: { ...process.env, ...request.environment },
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return new ClaudeAttachedSession(
      child,
      request.sessionId,
      this.now,
      this.onStdout,
      this.onStderr,
    );
  }
}

async function detectExecutable(executable: string, cwd: string): Promise<DetectionResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (result: DetectionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', () => finish({ available: false, confidence: 1, reason: 'spawn_error' }));
    child.once('close', (exitCode) => {
      const version = stdout.trim().split(/\r?\n/u)[0];
      finish(
        exitCode === 0
          ? { available: true, confidence: 1, ...(version === '' ? {} : { version }) }
          : {
              available: false,
              confidence: 1,
              ...(version === '' ? {} : { version }),
              reason: 'non_zero_exit',
            },
      );
    });
  });
}

class ClaudeAttachedSession implements AttachedSession {
  private readonly decoder: ClaudeStreamDecoder;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private readonly queue = new AsyncEventQueue();
  private stopRequested = false;
  private detached = false;
  private started = false;
  private terminal = false;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly sessionId: string,
    private readonly now: () => number,
    private readonly onStdout?: (chunk: string) => void,
    private readonly onStderr?: (chunk: string) => void,
  ) {
    this.decoder = new ClaudeStreamDecoder({ sessionId, source: SOURCE });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.onStdout?.(chunk);
      for (const result of this.decoder.push(chunk)) this.publishResult(result);
    });
    child.stderr?.on('data', (chunk: string) => this.onStderr?.(chunk));
    child.once('error', () => {
      if (!this.detached) {
        this.publish(
          createEvent('error', this.sessionId, this.now(), {
            code: 'spawn_error',
            message: 'Claude process could not be started.',
          }),
        );
      }
    });
    child.once('close', (exitCode, signal) => this.finish(exitCode, signal));
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.stopRequested = true;
    this.child.kill();
  }

  async detach(): Promise<void> {
    if (this.closed) return;
    this.detached = true;
    this.listeners.clear();
    this.child.kill();
    this.queue.end();
    this.closed = true;
  }

  private publishResult(result: ReturnType<typeof parseClaudeStreamLine>): void {
    for (const event of result.events) this.publish(event);
  }

  private publish(event: AgentEvent): void {
    if (this.closed) return;
    if (event.type === 'session_started') this.started = true;
    else if (!this.started) {
      this.started = true;
      this.publish(createEvent('session_started', this.sessionId, this.now(), {}));
    }
    if (event.type === 'session_finished') this.terminal = true;
    this.queue.push(event);
    for (const listener of this.listeners) void Promise.resolve(listener(event)).catch(() => {});
  }

  private finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    for (const result of this.decoder.flush()) this.publishResult(result);
    if (!this.started) this.publish(createEvent('session_started', this.sessionId, this.now(), {}));
    if (!this.terminal && !this.detached) {
      this.publish(
        createEvent('session_finished', this.sessionId, this.now(), {
          reason:
            signal === null && exitCode === 0 && !this.stopRequested
              ? 'completed'
              : signal !== null || this.stopRequested
                ? 'interrupted'
                : 'failed',
          ...(exitCode === null ? {} : { exitCode }),
        }),
      );
    }
    this.queue.end();
    this.closed = true;
  }
}

class AsyncEventQueue implements AsyncIterableIterator<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private ended = false;

  push(event: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<AgentEvent>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> {
    return this;
  }
}

function createEvent(
  type: AgentEvent['type'],
  sessionId: string,
  timestamp: number,
  payload: unknown,
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    timestamp,
    source: SOURCE,
    type,
    payload,
    confidence: 0.9,
  };
}
