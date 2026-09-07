import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { reduceSessionState } from '@agentscope/core';
import {
  createInitialSessionState,
  type AgentEvent,
  type EventSource,
  type SessionState,
} from '@agentscope/protocol';
import { openStorage, StorageRepository } from '@agentscope/storage';
import { nodePtyDriver, TerminalSession, type TerminalDriver } from '@agentscope/terminal';

export interface InteractiveSignals {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface InteractiveProviderOptions {
  readonly adapter: 'claude';
  readonly args: readonly string[];
  readonly filename: string;
  readonly workspacePath: string;
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Only auto-confirm the provider's explicit API-key confirmation prompt.
   * This never answers tool approvals, slash commands, or other prompts.
   */
  readonly autoAcceptApiKey?: boolean;
  readonly sessionId?: string;
  readonly now?: () => number;
  readonly input?: InteractiveInput;
  readonly output?: InteractiveOutput;
  readonly error?: NodeJS.WritableStream;
  readonly signals?: InteractiveSignals;
  readonly terminalDriver?: TerminalDriver;
}

export type InteractiveInput = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
};

export type InteractiveOutput = NodeJS.WriteStream & {
  columns?: number;
  rows?: number;
};

export function prepareInteractiveEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...env };
  if (
    typeof environment.ANTHROPIC_BASE_URL === 'string' &&
    environment.ANTHROPIC_BASE_URL.length > 0 &&
    typeof environment.ANTHROPIC_API_KEY === 'string' &&
    environment.ANTHROPIC_API_KEY.length > 0 &&
    (environment.ANTHROPIC_AUTH_TOKEN === undefined ||
      environment.ANTHROPIC_AUTH_TOKEN.length === 0)
  ) {
    environment.ANTHROPIC_AUTH_TOKEN = environment.ANTHROPIC_API_KEY;
  }
  return environment;
}

export async function runInteractiveProvider(options: InteractiveProviderOptions): Promise<number> {
  ensureStorageDirectory(options.filename);
  const now = options.now ?? Date.now;
  const sessionId = options.sessionId ?? randomUUID();
  const startedAt = now();
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new StorageRepository(storage.client);
  let state = createInitialSessionState(sessionId, startedAt);
  const source: EventSource = {
    provider: options.adapter,
    client: 'claude-code',
    environment: process.platform,
    adapter: 'claude-code-tty',
  };
  repository.createSession({
    id: sessionId,
    provider: options.adapter,
    adapter: 'claude-code-tty',
    startedAt,
    capabilities: {
      structuredEvents: false,
      toolCalls: false,
      fileEvents: false,
      commandEvents: false,
      tokenUsage: false,
      sessionInfo: true,
      milestones: false,
      tty: true,
    },
    workspace: { rootPath: options.workspacePath, mode: 'interactive-pty' },
    state,
    now: startedAt,
  });

  let terminal: TerminalSession | undefined;
  let interrupted = false;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const environment = prepareInteractiveEnvironment(options.env ?? process.env);
  const signals = options.signals ?? process;
  const driver = options.terminalDriver ?? nodePtyDriver;
  const onInput = (chunk: Buffer | string) => {
    if (terminal?.state !== 'running') return;
    terminal.write(typeof chunk === 'string' ? chunk : chunk.toString());
  };
  const onResize = () => {
    if (terminal?.state !== 'running') return;
    const cols = output.columns ?? 120;
    const rows = output.rows ?? 30;
    terminal.resize({ cols: Math.max(1, cols), rows: Math.max(1, rows) });
  };
  let interruptCount = 0;
  const onSignal = () => {
    if (terminal?.state !== 'running') return;
    if (interruptCount === 0) {
      interruptCount += 1;
      interrupted = true;
      terminal.interrupt();
    } else {
      terminal.kill();
    }
  };

  try {
    try {
      const executable = resolveExecutable(options.executable ?? 'claude');
      if (executable === undefined) {
        throw new Error('Claude executable was not found in PATH or the npm installation.');
      }
      terminal = TerminalSession.spawn(driver, {
        command: executable,
        args: [...options.args],
        cwd: options.workspacePath,
        env: environment,
        dimensions: {
          cols: Math.max(1, output.columns ?? 120),
          rows: Math.max(1, output.rows ?? 30),
        },
      });
    } catch (error) {
      const message = `Unable to start Claude in a PTY: ${error instanceof Error ? error.message : String(error)} Verify that \`claude --version\` works in this terminal.`;
      (options.error ?? process.stderr).write(`${message}\n`);
      appendEvent(
        repository,
        state,
        createEvent('error', sessionId, now(), source, {
          code: 'pty_spawn_error',
          message,
        }),
      );
      state = appendEvent(
        repository,
        state,
        createEvent('session_finished', sessionId, now(), source, {
          reason: 'failed',
        }),
      );
      return 1;
    }

    state = appendEvent(
      repository,
      state,
      createEvent('session_started', sessionId, now(), source, {}),
    );
    let startupOutput = '';
    let apiKeyAccepted = false;
    terminal.onData((chunk) => {
      output.write(chunk);
      if (
        options.autoAcceptApiKey !== true ||
        apiKeyAccepted ||
        typeof environment.ANTHROPIC_API_KEY !== 'string' ||
        environment.ANTHROPIC_API_KEY.length === 0
      ) {
        return;
      }
      startupOutput = stripAnsi(startupOutput + chunk).slice(-8_192);
      if (!API_KEY_CONFIRMATION_PATTERN.test(startupOutput)) return;
      terminal?.write('yes\r');
      apiKeyAccepted = true;
    });
    input.on('data', onInput);
    input.resume();
    input.setRawMode?.(true);
    output.on('resize', onResize);
    signals.on('SIGINT', onSignal);

    const exit = await new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      terminal?.onExit((event) => resolve(event));
    });
    const reason =
      interrupted || isInterruptExit(exit.exitCode)
        ? 'interrupted'
        : exit.exitCode === 0
          ? 'completed'
          : 'failed';
    state = appendEvent(
      repository,
      state,
      createEvent('session_finished', sessionId, now(), source, {
        reason,
        exitCode: exit.exitCode,
      }),
    );
    return state.status === 'completed' ? 0 : state.status === 'interrupted' ? 130 : 1;
  } finally {
    input.removeListener('data', onInput);
    input.pause();
    input.setRawMode?.(false);
    output.removeListener('resize', onResize);
    signals.removeListener('SIGINT', onSignal);
    terminal?.dispose();
    storage.client.close();
  }
}

function appendEvent(
  repository: StorageRepository,
  state: SessionState,
  event: AgentEvent,
): SessionState {
  const next = reduceSessionState(state, event);
  repository.appendEvent(event, next, event.timestamp);
  return next;
}

function createEvent(
  type: AgentEvent['type'],
  sessionId: string,
  timestamp: number,
  source: EventSource,
  payload: unknown,
): AgentEvent {
  return { id: randomUUID(), sessionId, timestamp, source, type, payload, confidence: 1 };
}

function isInterruptExit(exitCode: number): boolean {
  return exitCode === 130 || exitCode === -1073741510;
}

const API_KEY_CONFIRMATION_PATTERN =
  /(?:do you want to use|use)\s+(?:this|the current)?\s*api key/iu;

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

function ensureStorageDirectory(filename: string): void {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function resolveExecutable(executable: string): string | undefined {
  if (process.platform !== 'win32' || path.extname(executable) !== '') return executable;
  const searchPath = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of searchPath) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const shimNames = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name === `${executable}.exe` ||
            entry.name === `${executable}.cmd` ||
            entry.name === `${executable}.bat` ||
            entry.name.startsWith(`.${executable}.cmd-`) ||
            entry.name.startsWith(`.${executable}.bat-`)),
      )
      .map((entry) => entry.name);
    for (const name of shimNames) {
      const extension = path.extname(name).toLowerCase();
      const candidate = path.join(directory, name);
      if (!fs.existsSync(candidate)) continue;
      if (extension === '.exe') {
        if (isWindowsExecutable(candidate)) return candidate;
        continue;
      }
      const target = fs.readFileSync(candidate, 'utf8').match(/"([^"\r\n]+\.exe)"/iu)?.[1];
      if (target === undefined) continue;
      const expanded = target.replace(/%~?dp0%/giu, directory);
      const resolved = path.resolve(expanded);
      if (fs.existsSync(resolved) && isWindowsExecutable(resolved)) return resolved;
    }
    const packageExecutable = path.join(
      directory,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      `${executable}.exe`,
    );
    if (fs.existsSync(packageExecutable) && isWindowsExecutable(packageExecutable)) {
      return packageExecutable;
    }
  }
  return undefined;
}

function isWindowsExecutable(filename: string): boolean {
  try {
    const header = Buffer.alloc(2);
    const handle = fs.openSync(filename, 'r');
    try {
      fs.readSync(handle, header, 0, 2, 0);
    } finally {
      fs.closeSync(handle);
    }
    return header[0] === 0x4d && header[1] === 0x5a;
  } catch {
    return false;
  }
}
