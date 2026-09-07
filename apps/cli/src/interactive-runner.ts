import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  classifyTurnInput,
  PtyTurnSignalDetector,
  reduceSessionState,
  TurnCoordinator,
  TurnSignalArbiter,
} from '@agentscope/core';
import {
  createInitialSessionState,
  type AgentEvent,
  type EventSource,
  type SessionState,
} from '@agentscope/protocol';
import { openStorage, StorageRepository } from '@agentscope/storage';
import { nodePtyDriver, TerminalSession, type TerminalDriver } from '@agentscope/terminal';
import { ObserverRuntime } from '@agentscope/observer-runtime';

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
  /** Store the full, redacted task text; false retains only its compact title. */
  readonly persistPrompt?: boolean;
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
  let observerRuntime: ObserverRuntime | undefined;
  let interrupted = false;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const environment = prepareInteractiveEnvironment(options.env ?? process.env);
  const signals = options.signals ?? process;
  const driver = options.terminalDriver ?? nodePtyDriver;
  const coordinator = new TurnCoordinator({
    sessionId,
    ...(options.persistPrompt === undefined ? {} : { persistPrompt: options.persistPrompt }),
    onUpdate: (update) => {
      const timestamp = now();
      if (update.kind === 'started') {
        repository.createTurn({ state: update.turn, now: timestamp });
      } else {
        repository.updateTurnState(update.turn.turnId, update.turn, timestamp);
      }
      repository.saveObserverEvidence({
        id: randomUUID(),
        sessionId,
        turnId: update.turn.turnId,
        key: `interactive-turn:${update.turn.turnId}:${update.kind}:${update.turn.status}`,
        timestamp,
        source: 'interactive-pty',
        kind: 'turn-boundary',
        confidence: 1,
        reason: turnEvidenceReason(update.kind, update.turn.status),
        payload: {
          turnId: update.turn.turnId,
          sequence: update.turn.sequence,
          status: update.turn.status,
          ...(update.turn.title === undefined ? {} : { title: update.turn.title }),
        },
      });
      state = appendEvent(
        repository,
        state,
        createEvent(
          turnEventType(update.kind),
          sessionId,
          timestamp,
          source,
          turnEventPayload(update.kind, update.turn),
        ),
      );
    },
  });
  const arbiter = new TurnSignalArbiter(coordinator);
  const detector = new PtyTurnSignalDetector({
    enablePromptCompletion: !options.args.includes('--bare'),
  });
  const inputDecoder = new ConsoleInputDecoder();
  const inputObservation = new TerminalInputObservation();
  let inputBuffer = '';
  const onInput = (chunk: Buffer | string) => {
    if (terminal?.state !== 'running') return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    const normalized = inputDecoder.decode(text);
    const snapshotNeeded = inputObservation.observe(text, normalized);
    if (snapshotNeeded) saveInputObservation(repository, sessionId, inputObservation, now());
    inputBuffer += normalized;
    const lines = inputBuffer.split(/[\r\n]/u);
    inputBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const classification = classifyTurnInput(line);
      if (!classification.accepted) continue;
      if (coordinator.mode === 'idle') {
        arbiter.apply({
          kind: 'task_submitted',
          prompt: line,
          source: 'manual',
          confidence: 1,
          timestamp: now(),
        });
      } else if (coordinator.mode === 'waiting' || coordinator.mode === 'blocked') {
        arbiter.apply({ kind: 'resumed', source: 'manual', confidence: 1, timestamp: now() });
      }
    }
    // node-pty can synchronously surface provider output while handling write().
    // Establish the task boundary first so that output belongs to this turn.
    terminal.write(text);
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
      if (coordinator.current !== undefined) {
        arbiter.apply({
          kind: 'finished',
          reason: 'interrupted',
          source: 'manual',
          confidence: 1,
          timestamp: now(),
        });
      }
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
    const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      terminal?.onExit((event) => resolve(event));
    });
    observerRuntime = new ObserverRuntime({
      sessionId,
      workspacePath: options.workspacePath,
      process: { pid: terminal.pid, startedAt },
      file: {},
      onEvidence: (evidence) => {
        const activeTurn = coordinator.current;
        repository.saveObserverEvidence({
          id: evidence.id,
          sessionId,
          ...(activeTurn === undefined ? {} : { turnId: activeTurn.turnId }),
          key: evidence.key,
          timestamp: evidence.timestamp,
          source: evidence.source,
          kind: evidence.kind,
          confidence: evidence.confidence,
          reason: evidence.reason,
          payload: evidence.payload,
        });
      },
      onError: (error) => {
        (options.error ?? process.stderr).write(`[observer:${error.source}] ${error.message}\n`);
      },
    });
    let startupOutput = '';
    let apiKeyAccepted = false;
    terminal.onData((chunk) => {
      output.write(chunk);
      for (const signal of detector.ingest(chunk, now())) arbiter.apply(signal);
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
    await observerRuntime.start();

    const exit = await exitPromise;
    const reason =
      interrupted || isInterruptExit(exit.exitCode)
        ? 'interrupted'
        : exit.exitCode === 0
          ? 'completed'
          : 'failed';
    if (inputObservation.hasInput) {
      saveInputObservation(repository, sessionId, inputObservation, now());
    }
    if (coordinator.current !== undefined) {
      arbiter.apply({
        kind: 'finished',
        reason,
        source: 'manual',
        confidence: 1,
        timestamp: now(),
      });
    }
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
    observerRuntime?.stop();
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

function turnEventType(
  kind: 'started' | 'updated' | 'finished',
): 'turn_started' | 'turn_updated' | 'turn_finished' {
  return kind === 'started'
    ? 'turn_started'
    : kind === 'updated'
      ? 'turn_updated'
      : 'turn_finished';
}

function turnEventPayload(
  kind: 'started' | 'updated' | 'finished',
  turn: {
    readonly turnId: string;
    readonly sequence: number;
    readonly status: string;
    readonly title?: string;
  },
): unknown {
  if (kind === 'started') {
    return {
      turnId: turn.turnId,
      sequence: turn.sequence,
      ...(turn.title === undefined ? {} : { title: turn.title }),
    };
  }
  if (kind === 'updated') return { turnId: turn.turnId, status: turn.status };
  return { turnId: turn.turnId, reason: turn.status };
}

function turnEvidenceReason(kind: 'started' | 'updated' | 'finished', status: string): string {
  return kind === 'started'
    ? 'Interactive task submitted.'
    : kind === 'finished'
      ? `Interactive task ${status}.`
      : `Interactive task is ${status}.`;
}

class TerminalInputObservation {
  private chunks = 0;
  private rawCharacters = 0;
  private normalizedCharacters = 0;
  private sawSubmission = false;
  private readonly encodings = new Set<string>();

  get hasInput(): boolean {
    return this.chunks > 0;
  }

  observe(raw: string, normalized: string): boolean {
    this.chunks += 1;
    this.rawCharacters += raw.length;
    this.normalizedCharacters += normalized.length;
    const submission = /[\r\n]/u.test(normalized);
    const encoding = describeInputEncoding(raw);
    const changedEncoding = !this.encodings.has(encoding);
    this.encodings.add(encoding);
    this.sawSubmission ||= submission;
    return this.chunks === 1 || submission || changedEncoding;
  }

  payload(): Record<string, unknown> {
    return {
      chunks: this.chunks,
      rawCharacters: this.rawCharacters,
      normalizedCharacters: this.normalizedCharacters,
      sawSubmission: this.sawSubmission,
      encodings: [...this.encodings].sort(),
    };
  }
}

function saveInputObservation(
  repository: StorageRepository,
  sessionId: string,
  observation: TerminalInputObservation,
  timestamp: number,
): void {
  repository.saveObserverEvidence({
    id: randomUUID(),
    sessionId,
    key: 'interactive-terminal-input',
    timestamp,
    source: 'interactive-pty',
    kind: 'input-observation',
    confidence: 1,
    reason: 'Interactive terminal input observed (content not stored).',
    payload: observation.payload(),
  });
}

function describeInputEncoding(raw: string): string {
  if (raw.includes(CONSOLE_RECORD_PREFIX)) return 'windows-console-record';
  if (raw.includes(CONSOLE_ESCAPE + '[<')) return 'sgr-mouse';
  if (raw.includes(CONSOLE_ESCAPE + '[') && raw.includes('u')) return 'csi-u';
  if (raw.includes(CONSOLE_ESCAPE + '[200~')) return 'bracketed-paste';
  return 'plain-text';
}

/**
 * Decodes Windows Console input records emitted by modern terminal hosts while
 * preserving all other input unchanged. The original bytes still go to Claude;
 * this normalized text is only used to identify submitted task boundaries.
 */
export class ConsoleInputDecoder {
  private pending = '';

  decode(chunk: string): string {
    this.pending += chunk;
    let decoded = '';
    while (this.pending.length > 0) {
      const start = this.pending.indexOf(CONSOLE_ESCAPE);
      if (start === -1) {
        decoded += this.pending;
        this.pending = '';
        break;
      }
      decoded += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      if (!this.pending.startsWith(CONSOLE_RECORD_PREFIX)) {
        const control = this.pending.match(VT_CONTROL_PATTERN);
        if (control !== null) {
          this.pending = this.pending.slice(control[0].length);
          continue;
        }
        if (VT_CONTROL_PARTIAL_PATTERN.test(this.pending)) break;
        this.pending = this.pending.slice(1);
        continue;
      }
      const consoleRecord = this.pending.match(CONSOLE_RECORD_PREFIX_PATTERN);
      if (consoleRecord !== null) {
        this.pending = this.pending.slice(consoleRecord[0].length);
        const unicode = Number(consoleRecord[3]);
        const keyDown = consoleRecord[4] === '1';
        if (keyDown && Number.isInteger(unicode) && unicode > 0 && unicode <= 0x10ffff) {
          decoded += String.fromCodePoint(unicode);
        }
        continue;
      }
      const keyboard = this.pending.match(CSI_U_KEYBOARD_PATTERN);
      if (keyboard !== null) {
        this.pending = this.pending.slice(keyboard[0].length);
        const codePoint = Number(keyboard[1]);
        const eventType = keyboard[3] === undefined ? 1 : Number(keyboard[3]);
        if (
          eventType !== 3 &&
          Number.isInteger(codePoint) &&
          codePoint > 0 &&
          codePoint <= 0x10ffff
        ) {
          decoded += String.fromCodePoint(codePoint);
        }
        continue;
      }
      if (CSI_U_KEYBOARD_PARTIAL_PATTERN.test(this.pending)) break;
      if (CONSOLE_RECORD_PARTIAL_PATTERN.test(this.pending)) break;
      const control = this.pending.match(VT_CONTROL_PATTERN);
      if (control !== null) {
        this.pending = this.pending.slice(control[0].length);
        continue;
      }
      if (VT_CONTROL_PARTIAL_PATTERN.test(this.pending)) break;
      this.pending = this.pending.slice(1);
      break;
    }
    return decoded;
  }
}

const CONSOLE_ESCAPE = String.fromCharCode(0x1b);
const CONSOLE_RECORD_PREFIX = CONSOLE_ESCAPE + '[';
const CONSOLE_RECORD_PARTIAL_PATTERN = new RegExp('^' + CONSOLE_ESCAPE + '\\[[0-9;]*$', 'u');
const CONSOLE_RECORD_PREFIX_PATTERN = new RegExp(
  '^' + CONSOLE_ESCAPE + '\\[(\\d+);(\\d+);(\\d+);([01]);(\\d+);(\\d+)_',
  'u',
);
const CSI_U_KEYBOARD_PATTERN = new RegExp(
  '^' + CONSOLE_ESCAPE + '\\[(\\d+)(?:;(\\d+)(?::(\\d+))?)?u',
  'u',
);
const CSI_U_KEYBOARD_PARTIAL_PATTERN = new RegExp(
  '^' + CONSOLE_ESCAPE + '\\[\\d*(?:;\\d*(?::\\d*)?)?$',
  'u',
);
const VT_CONTROL_PATTERN = new RegExp(
  '^' +
    CONSOLE_ESCAPE +
    '(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|' +
    CONSOLE_ESCAPE +
    '\\\\)|P[\\s\\S]*?' +
    CONSOLE_ESCAPE +
    '\\\\)',
  'u',
);
const VT_CONTROL_PARTIAL_PATTERN = new RegExp(
  '^' + CONSOLE_ESCAPE + '(?:\\[[0-?]*[ -/]*|\\][^\\u0007]*|P[\\s\\S]*)$',
  'u',
);

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
