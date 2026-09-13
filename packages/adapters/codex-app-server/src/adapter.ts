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
import type { AgentEvent, EventSource } from '@agentscope/protocol';

import {
  CodexAppServerStreamDecoder,
  type AppServerMessage,
  type CodexAppServerCommandKind,
  type CodexAppServerParseResult,
} from './parser.js';

export interface CodexAppServerAdapterOptions {
  readonly executable?: string;
  readonly now?: () => number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  /**
   * Optional transient classifier for command verification. Raw command text
   * is only passed to this callback and never copied into normalized events.
   */
  readonly classifyCommand?: (commandName: string) => CodexAppServerCommandKind;
  /** Internal test hook; production uses `codex app-server --listen stdio://`. */
  readonly commandPrefix?: readonly string[];
}

interface AppServerPromptRequest {
  readonly prompt: string;
  readonly resumeThreadId?: string;
}

const CAPABILITIES: AgentCapabilities = {
  structuredEvents: true,
  toolCalls: true,
  fileEvents: true,
  commandEvents: true,
  tokenUsage: true,
  sessionInfo: true,
  milestones: true,
};

const SOURCE: EventSource = {
  provider: 'codex',
  client: 'codex-app-server',
  environment: process.platform,
  adapter: 'codex-app-server',
};

export class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex-app-server';
  private readonly executable: string;
  private readonly now: () => number;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly classifyCommand:
    ((commandName: string) => CodexAppServerCommandKind) | undefined;
  private readonly commandPrefix: readonly string[];

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.now = options.now ?? Date.now;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
    this.classifyCommand = options.classifyCommand;
    this.commandPrefix = options.commandPrefix ?? ['app-server', '--listen', 'stdio://'];
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
    const promptRequest = parsePromptRequest(request.args);
    if (promptRequest.prompt.length === 0) {
      throw new Error('Codex app-server runs require a prompt after `--`.');
    }
    const resolved = resolveExecutable(this.executable);
    const child = spawn(resolved.executable, [...resolved.args, ...this.commandPrefix], {
      cwd: request.workspacePath,
      env: { ...process.env, ...request.environment },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CodexAppServerAttachedSession(
      child,
      request.sessionId,
      request.workspacePath,
      promptRequest.prompt,
      promptRequest.resumeThreadId,
      this.now,
      this.onStdout,
      this.onStderr,
      this.classifyCommand,
    );
  }
}

interface ResolvedExecutable {
  readonly executable: string;
  readonly args: readonly string[];
}

function resolveExecutable(executable: string): ResolvedExecutable {
  if (process.platform !== 'win32' || path.extname(executable) !== '')
    return { executable, args: [] };
  if (executable.includes('/') || executable.includes('\\')) return { executable, args: [] };
  const searchPath = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of searchPath) {
    for (const extension of ['.exe', '.com', '.cmd', '.bat']) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (!fs.existsSync(candidate)) continue;
      if (extension === '.cmd' || extension === '.bat') {
        const target = resolveShimTarget(candidate);
        if (target !== undefined) return target;
      } else return { executable: candidate, args: [] };
    }
  }
  return { executable, args: [] };
}

function resolveShimTarget(filename: string): ResolvedExecutable | undefined {
  const text = fs.readFileSync(filename, 'utf8');
  const directory = path.dirname(filename);
  const directTarget = text.match(/"([^"\r\n]+\.exe)"/iu)?.[1];
  if (directTarget !== undefined) {
    const resolved = expandShimPath(directTarget, directory);
    if (fs.existsSync(resolved)) return { executable: resolved, args: [] };
  }
  const scriptTarget = text.match(/"([^"\r\n]+\.js)"\s+%\*/iu)?.[1];
  if (scriptTarget === undefined) return undefined;
  const script = expandShimPath(scriptTarget, directory);
  if (!fs.existsSync(script)) return undefined;
  const localNodeTarget = text.match(/SET\s+"_prog=([^"\r\n]*node\.exe)"/iu)?.[1];
  const localNode =
    localNodeTarget === undefined ? undefined : expandShimPath(localNodeTarget, directory);
  return {
    executable: localNode !== undefined && fs.existsSync(localNode) ? localNode : process.execPath,
    args: [script],
  };
}

function expandShimPath(value: string, directory: string): string {
  return path.resolve(value.replace(/%~?dp0%/giu, directory));
}

async function detectExecutable(
  resolved: ResolvedExecutable,
  cwd: string,
): Promise<DetectionResult> {
  return new Promise((resolve) => {
    const child = spawn(resolved.executable, [...resolved.args, '--version'], {
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

class CodexAppServerAttachedSession implements AttachedSession {
  private readonly decoder: CodexAppServerStreamDecoder;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private readonly queue = new AsyncEventQueue();
  private nextRequestId = 1;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private started = false;
  private terminal = false;
  private detached = false;
  private stopRequested = false;
  private invalidOutput = false;
  private validCompletionObserved = false;
  private closed = false;

  get pid(): number | undefined {
    return this.child.pid;
  }

  constructor(
    private readonly child: ChildProcess,
    private readonly sessionId: string,
    private readonly workspacePath: string,
    private readonly prompt: string,
    private readonly resumeThreadId: string | undefined,
    private readonly now: () => number,
    private readonly onStdout?: (chunk: string) => void,
    private readonly onStderr?: (chunk: string) => void,
    classifyCommand?: (commandName: string) => CodexAppServerCommandKind,
  ) {
    this.decoder = new CodexAppServerStreamDecoder({
      sessionId,
      now,
      source: SOURCE,
      ...(classifyCommand === undefined ? {} : { classifyCommand }),
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.onStdout?.(chunk);
      for (const result of this.decoder.push(chunk)) this.handleParseResult(result);
    });
    child.stderr?.on('data', (chunk: string) => this.onStderr?.(chunk));
    child.once('error', (error) => {
      if (this.closed || this.detached) return;
      this.publish({
        id: randomUUID(),
        sessionId,
        timestamp: this.now(),
        source: SOURCE,
        type: 'error',
        payload: { code: 'spawn_error', message: error.message },
        confidence: 0.95,
      });
      this.finish('failed');
    });
    child.once('close', (exitCode, signal) => {
      for (const result of this.decoder.flush()) this.handleParseResult(result);
      if (!this.terminal && !this.detached) {
        this.finish(
          signal !== null || this.stopRequested
            ? 'interrupted'
            : exitCode === 0
              ? 'completed'
              : 'failed',
        );
      } else {
        this.closeQueue();
      }
    });
    this.send({
      id: this.nextRequestId++,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agentscope', title: 'AgentScope', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
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
    if (this.turnId !== undefined) {
      this.send({
        id: this.nextRequestId++,
        method: 'turn/interrupt',
        params: { threadId: this.threadId, turnId: this.turnId },
      });
      // Give the protocol a short opportunity to acknowledge the interrupt;
      // the hard kill below remains the bounded fallback for a broken server.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!this.closed && !this.child.killed) this.child.kill();
  }

  async detach(): Promise<void> {
    if (this.closed) return;
    this.detached = true;
    this.listeners.clear();
    this.child.kill();
    this.closeQueue();
  }

  private handleParseResult(result: CodexAppServerParseResult): void {
    const message = result.message;
    if (result.malformed) {
      this.invalidOutput = true;
      this.publish({
        id: randomUUID(),
        sessionId: this.sessionId,
        timestamp: this.now(),
        source: SOURCE,
        type: 'error',
        payload: {
          code: 'invalid_output',
          message: 'Codex app-server emitted malformed JSON-RPC output.',
        },
        confidence: 0.95,
      });
    }
    if (message !== undefined) this.handleMessage(message);
    for (const event of result.events) this.publish(event);
    if (message?.method === 'turn/completed') {
      this.validCompletionObserved = true;
      const params = recordValue(message.params);
      const turn = recordValue(params?.turn);
      const status = stringValue(turn?.status);
      this.finish(
        status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed',
      );
    } else if (message?.method === 'error') {
      const params = recordValue(message.params);
      if (params?.willRetry !== true) this.finish('failed');
    }
  }

  private handleMessage(message: AppServerMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.error !== undefined) {
      this.publish({
        id: randomUUID(),
        sessionId: this.sessionId,
        timestamp: this.now(),
        source: SOURCE,
        type: 'error',
        payload: { code: 'app_server_error', message: errorMessage(message.error) },
        confidence: 0.95,
      });
      this.finish('failed');
      return;
    }
    const result = recordValue(message.result);
    if (message.id === 1 && result !== undefined) {
      this.send({ method: 'initialized', params: {} });
      this.send(
        this.resumeThreadId === undefined
          ? {
              id: this.nextRequestId++,
              method: 'thread/start',
              params: { cwd: this.workspacePath, ephemeral: true },
            }
          : {
              id: this.nextRequestId++,
              method: 'thread/resume',
              params: { threadId: this.resumeThreadId, cwd: this.workspacePath },
            },
      );
      return;
    }
    if (result === undefined) return;
    if (result.thread !== undefined) {
      const thread = recordValue(result.thread);
      const id = stringValue(thread?.id);
      if (id !== undefined && this.threadId === undefined) {
        this.threadId = id;
        this.publish({
          id: randomUUID(),
          sessionId: this.sessionId,
          timestamp: this.now(),
          source: SOURCE,
          type: 'session_started',
          payload: { providerSessionId: id },
          confidence: 0.98,
        });
        this.publish({
          id: randomUUID(),
          sessionId: this.sessionId,
          timestamp: this.now(),
          source: SOURCE,
          type: 'provider_info',
          payload: {
            providerSessionId: id,
            ...(stringValue(thread?.model) === undefined
              ? {}
              : { model: stringValue(thread?.model) }),
            ...(stringValue(thread?.cliVersion) === undefined
              ? {}
              : { cliVersion: stringValue(thread?.cliVersion) }),
            outputFormat: 'app-server',
          },
          confidence: 0.98,
        });
        this.send({
          id: this.nextRequestId++,
          method: 'turn/start',
          params: {
            threadId: id,
            input: [{ type: 'text', text: this.prompt, text_elements: [] }],
          },
        });
      }
    }
    if (result.turn !== undefined) {
      const turn = recordValue(result.turn);
      const id = stringValue(turn?.id);
      if (id !== undefined) this.turnId = id;
    }
  }

  private handleServerRequest(message: AppServerMessage): void {
    if (message.id === undefined || message.method === undefined) return;
    const reason = `Codex requested ${message.method}; this non-interactive wrapper has no approval UI.`;
    this.publish({
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.now(),
      source: SOURCE,
      type: 'blocked',
      payload: { reason },
      confidence: 0.95,
    });
    const result = serverRequestDecline(message.method);
    if (result !== undefined) {
      this.send({ id: message.id, result });
    } else {
      this.send({
        id: message.id,
        error: { code: -32001, message: `Unsupported Codex app-server request: ${message.method}` },
      });
    }
  }

  private publish(event: AgentEvent): void {
    if (this.closed || this.detached) return;
    if (event.type === 'session_started') this.started = true;
    if (!this.started && event.type !== 'provider_event') {
      this.started = true;
      this.enqueue({
        id: randomUUID(),
        sessionId: this.sessionId,
        timestamp: this.now(),
        source: SOURCE,
        type: 'session_started',
        payload: {},
        confidence: 0.8,
      });
    }
    this.enqueue(event);
  }

  private finish(reason: 'completed' | 'failed' | 'interrupted'): void {
    if (this.terminal || this.closed || this.detached) return;
    this.terminal = true;
    const finalReason =
      reason === 'completed' && this.invalidOutput && !this.validCompletionObserved
        ? 'failed'
        : reason;
    this.publish({
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: this.now(),
      source: SOURCE,
      type: 'session_finished',
      payload: { reason: finalReason },
      confidence: 0.95,
    });
    this.closeQueue();
    // app-server is a long-lived JSON-RPC server. A one-shot AgentScope run
    // must tear it down after the requested turn, otherwise the CLI would
    // keep waiting even though the session is already terminal.
    if (!this.child.killed) this.child.kill();
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.detached || this.child.stdin === null || this.child.stdin.destroyed)
      return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private enqueue(event: AgentEvent): void {
    this.queue.push(event);
    for (const listener of this.listeners) void Promise.resolve(listener(event)).catch(() => {});
  }

  private closeQueue(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.end();
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = recordValue(value);
  return stringValue(record?.message) ?? 'Codex app-server request failed.';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsePromptRequest(args: readonly string[]): AppServerPromptRequest {
  const prompt: string[] = [];
  let resumeThreadId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--resume') {
      const candidate = args[index + 1];
      if (candidate === undefined || candidate.length === 0) {
        throw new Error('Codex app-server `--resume` requires a thread id.');
      }
      resumeThreadId = candidate;
      index += 1;
      continue;
    }
    if (argument !== undefined) prompt.push(argument);
  }
  return {
    prompt: prompt.join(' ').trim(),
    ...(resumeThreadId === undefined ? {} : { resumeThreadId }),
  };
}

function serverRequestDecline(method: string): Record<string, unknown> | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: 'AgentScope has no interactive approval UI.' } } };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn', strictAutoReview: null };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null };
    default:
      return undefined;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
