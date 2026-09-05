import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentAdapter,
  AgentCapabilities,
  AttachedSession,
  AdapterDetectContext,
  DetectionResult,
  StartAgentRequest,
} from '@agentscope/adapter-base';
import type { AgentEvent } from '@agentscope/protocol';

import { CodexStreamDecoder, type CodexParseResult } from './parser.js';

export interface CodexCliAdapterOptions {
  readonly executable?: string;
  readonly now?: () => number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

const CAPABILITIES: AgentCapabilities = {
  structuredEvents: true,
  toolCalls: false,
  fileEvents: false,
  commandEvents: true,
  tokenUsage: false,
  sessionInfo: true,
  milestones: false,
};

export class CodexCliAdapter implements AgentAdapter {
  readonly id = 'codex-cli';
  private readonly executable: string;
  private readonly now: () => number;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly onStderr: ((chunk: string) => void) | undefined;

  constructor(options: CodexCliAdapterOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.now = options.now ?? Date.now;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
  }

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async detect(context: AdapterDetectContext): Promise<DetectionResult> {
    return detectExecutable(
      resolveExecutable(context.executablePath ?? this.executable),
      context.workspacePath,
    );
  }

  async start(request: StartAgentRequest): Promise<AttachedSession> {
    const args =
      request.args[0] === 'exec'
        ? [...request.args]
        : ['exec', '--json', '--ephemeral', ...request.args];
    const child = spawn(resolveExecutable(this.executable), args, {
      cwd: request.workspacePath,
      env: { ...process.env, ...request.environment },
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return new CodexAttachedSession(
      child,
      request.sessionId,
      this.now,
      this.onStdout,
      this.onStderr,
    );
  }
}

function resolveExecutable(executable: string): string {
  if (process.platform !== 'win32' || path.extname(executable) !== '') return executable;
  if (executable.includes('/') || executable.includes('\\')) return executable;
  const searchPath = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of searchPath) {
    for (const extension of ['.exe', '.com', '.cmd', '.bat']) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (!fs.existsSync(candidate)) continue;
      if (extension === '.cmd' || extension === '.bat') {
        const target = fs.readFileSync(candidate, 'utf8').match(/"([^"\r\n]+\.exe)"/iu)?.[1];
        if (target !== undefined) {
          const expanded = target.replace(/%~?dp0%/giu, path.dirname(candidate));
          const resolved = path.resolve(expanded);
          if (fs.existsSync(resolved)) return resolved;
        }
      } else return candidate;
    }
  }
  return executable;
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

class CodexAttachedSession implements AttachedSession {
  private readonly decoder: CodexStreamDecoder;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private readonly queue = new AsyncEventQueue();
  private stopRequested = false;
  private detached = false;
  private started = false;
  private terminalEvent: AgentEvent | undefined;
  private commandFailed = false;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly sessionId: string,
    private readonly now: () => number,
    private readonly onStdout?: (chunk: string) => void,
    private readonly onStderr?: (chunk: string) => void,
  ) {
    this.decoder = new CodexStreamDecoder({ sessionId });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.onStdout?.(chunk);
      for (const result of this.decoder.push(chunk)) this.publishResult(result);
    });
    child.stderr?.on('data', (chunk: string) => this.onStderr?.(chunk));
    child.once('error', () => {
      if (!this.detached) {
        this.publish({
          id: randomUUID(),
          sessionId,
          timestamp: this.now(),
          source: {
            provider: 'codex',
            client: 'codex-cli',
            environment: process.platform,
            adapter: 'codex-cli',
          },
          type: 'error',
          payload: { code: 'spawn_error', message: 'Codex process could not be started.' },
          confidence: 0.9,
        });
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

  private publishResult(result: CodexParseResult): void {
    for (const event of result.events) this.publish(event);
  }

  private publish(event: AgentEvent): void {
    if (this.closed) return;
    if (event.type === 'session_started') this.started = true;
    else if (!this.started) {
      this.started = true;
      this.publish(createStartedEvent(this.sessionId, this.now()));
    }
    if (event.type === 'session_finished') {
      this.terminalEvent = event;
      return;
    }
    if (event.type === 'command_finished' && isFailedCommand(event)) this.commandFailed = true;
    this.enqueue(event);
  }

  private finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    for (const result of this.decoder.flush()) this.publishResult(result);
    if (!this.started) this.publish(createStartedEvent(this.sessionId, this.now()));
    if (!this.detached) {
      if (
        this.terminalEvent !== undefined &&
        !this.commandFailed &&
        signal === null &&
        exitCode === 0 &&
        !this.stopRequested
      ) {
        this.enqueue(this.terminalEvent);
      } else {
        this.enqueue({
          id: randomUUID(),
          sessionId: this.sessionId,
          timestamp: this.now(),
          source: {
            provider: 'codex',
            client: 'codex-cli',
            environment: process.platform,
            adapter: 'codex-cli',
          },
          type: 'session_finished',
          payload: {
            reason:
              signal !== null || this.stopRequested
                ? 'interrupted'
                : exitCode === 0 && !this.commandFailed
                  ? 'completed'
                  : 'failed',
            ...(exitCode === null ? {} : { exitCode }),
          },
          confidence: 0.9,
        });
      }
    }
    this.queue.end();
    this.closed = true;
  }

  private enqueue(event: AgentEvent): void {
    this.queue.push(event);
    for (const listener of this.listeners) void Promise.resolve(listener(event)).catch(() => {});
  }
}

function isFailedCommand(event: AgentEvent): boolean {
  if (
    event.type !== 'command_finished' ||
    typeof event.payload !== 'object' ||
    event.payload === null
  ) {
    return false;
  }
  const exitCode = (event.payload as { exitCode?: unknown }).exitCode;
  return typeof exitCode === 'number' && exitCode !== 0;
}

function createStartedEvent(sessionId: string, timestamp: number): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    timestamp,
    source: {
      provider: 'codex',
      client: 'codex-cli',
      environment: process.platform,
      adapter: 'codex-cli',
    },
    type: 'session_started',
    payload: {},
    confidence: 0.9,
  };
}

class AsyncEventQueue implements AsyncIterableIterator<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private ended = false;

  push(value: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.values.push(value);
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
