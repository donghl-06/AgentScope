import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { reduceSessionState } from '@agentscope/core';
import { CodexCliAdapter } from '@agentscope/adapter-codex-cli';
import { CodexAppServerAdapter } from '@agentscope/adapter-codex-app-server';
import { ClaudeCodeAdapter } from '@agentscope/adapter-claude-code';
import { estimateEta } from '@agentscope/eta';
import { classifyWorkerFailure, type WorkerFailure } from '@agentscope/orchestrator';
import {
  classifyVerificationCommand,
  ObserverRuntime,
  type ObserverEvidence,
} from '@agentscope/observer-runtime';
import { createInitialSessionState, type SessionState } from '@agentscope/protocol';
import { computeProgress } from '@agentscope/progress';
import { openStorage, StorageRepository } from '@agentscope/storage';

import { shouldPersistEtaSnapshot } from './eta-snapshot.js';
import { applyContinuation, detectContinuation } from './continuation.js';
import { createVerificationEvent } from './verification-events.js';

export interface ProviderRunOptions {
  readonly adapter: 'claude' | 'codex' | 'codex-app-server';
  readonly args: readonly string[];
  readonly filename: string;
  readonly workspacePath: string;
  readonly executable?: string;
  readonly sessionId?: string;
  readonly writeStdout?: (chunk: string) => void;
  readonly writeStderr?: (chunk: string) => void;
  readonly onObserverEvidence?: (evidence: ObserverEvidence) => void;
  readonly now?: () => number;
  readonly signals?: ProviderRunSignals;
}

export interface ProviderRunSignals {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ProviderRunResult {
  readonly sessionId: string;
  readonly status: SessionState['status'];
  readonly exitCode: number;
  readonly eventCount: number;
  readonly failure?: WorkerFailure;
}

export async function runProvider(options: ProviderRunOptions): Promise<ProviderRunResult> {
  ensureStorageDirectory(options.filename);
  const now = options.now ?? Date.now;
  const sessionId = options.sessionId ?? randomUUID();
  const startedAt = now();
  const stderrChunks: string[] = [];
  let providerErrorCode: string | undefined;
  const writeProviderStderr = (chunk: string): void => {
    if (stderrChunks.length < 32) stderrChunks.push(chunk.slice(0, 4_096));
    options.writeStderr?.(chunk);
  };
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new StorageRepository(storage.client);
  let state = applyContinuation(
    createInitialSessionState(sessionId, startedAt),
    detectContinuation(options.args),
  );
  const adapter =
    options.adapter === 'claude'
      ? new ClaudeCodeAdapter({
          ...(options.executable === undefined ? {} : { executable: options.executable }),
          now,
          ...(options.writeStdout === undefined ? {} : { onStdout: options.writeStdout }),
          onStderr: writeProviderStderr,
        })
      : options.adapter === 'codex'
        ? new CodexCliAdapter({
            ...(options.executable === undefined ? {} : { executable: options.executable }),
            now,
            ...(options.writeStdout === undefined ? {} : { onStdout: options.writeStdout }),
            onStderr: writeProviderStderr,
            classifyCommand: (commandName) => {
              const kind = classifyVerificationCommand(commandName).kind;
              return kind === 'unknown' ? 'command' : kind;
            },
          })
        : new CodexAppServerAdapter({
            ...(options.executable === undefined ? {} : { executable: options.executable }),
            now,
            ...(options.writeStdout === undefined ? {} : { onStdout: options.writeStdout }),
            onStderr: writeProviderStderr,
            classifyCommand: (commandName) => {
              const kind = classifyVerificationCommand(commandName).kind;
              return kind === 'unknown' ? 'command' : kind;
            },
          });

  const providerName = options.adapter === 'claude' ? 'claude' : 'codex';
  const etaHistory = {
    durationsSeconds: repository
      .listEtaHistory({ provider: providerName, adapter: adapter.id })
      .map((sample) => sample.durationSeconds),
    scope: `${providerName}/${adapter.id}`,
  } as const;

  repository.createSession({
    id: sessionId,
    provider: options.adapter === 'claude' ? 'claude' : 'codex',
    adapter: adapter.id,
    startedAt,
    capabilities: { ...adapter.capabilities() },
    workspace: { rootPath: options.workspacePath },
    state,
    now: startedAt,
  });

  let eventCount = 0;
  let lastEtaSnapshot: SessionState['eta'];
  let attached: Awaited<ReturnType<NonNullable<(typeof adapter)['start']>>> | undefined;
  let observerRuntime: ObserverRuntime | undefined;
  const activeCommandIds: string[] = [];
  const observerSource = {
    provider: options.adapter === 'claude' ? 'claude' : 'codex',
    client: adapter.id,
    environment: process.platform,
    adapter: adapter.id,
  } as const;
  const signals = options.signals ?? process;
  let stopRequested = false;
  const handleSignal = () => {
    stopRequested = true;
    void attached?.stop('user_requested');
  };
  signals.once('SIGINT', handleSignal);
  signals.once('SIGTERM', handleSignal);
  try {
    attached = await adapter.start!({
      sessionId,
      workspacePath: options.workspacePath,
      args: options.args,
    });
    if (stopRequested) await attached.stop('user_requested');
    observerRuntime = new ObserverRuntime({
      sessionId,
      workspacePath: options.workspacePath,
      ...(attached.pid === undefined ? {} : { process: { pid: attached.pid } }),
      file: {},
      onEvidence: (evidence) => {
        options.onObserverEvidence?.(evidence);
        repository.saveObserverEvidence({
          id: evidence.id,
          sessionId,
          key: evidence.key,
          timestamp: evidence.timestamp,
          source: evidence.source,
          kind: evidence.kind,
          confidence: evidence.confidence,
          reason: evidence.reason,
          payload: evidence.payload,
        });
        const verificationEvent = createVerificationEvent(sessionId, observerSource, evidence);
        if (verificationEvent === undefined) return;
        state = reduceSessionState(state, verificationEvent);
        const progress = computeProgress({
          state,
          capabilities: adapter.capabilities(),
          now: verificationEvent.timestamp,
          lastSignalAt: verificationEvent.timestamp,
        });
        state = {
          ...state,
          progress,
          eta: estimateEta({
            state,
            progress,
            elapsedSeconds: Math.max(0, (verificationEvent.timestamp - startedAt) / 1_000),
            history: etaHistory,
          }),
        };
        repository.appendEvent(verificationEvent, state, verificationEvent.timestamp);
        if (
          state.eta !== undefined &&
          shouldPersistEtaSnapshot(verificationEvent.type, lastEtaSnapshot)
        ) {
          repository.saveEtaSnapshot(sessionId, state.eta, verificationEvent.timestamp);
          lastEtaSnapshot = state.eta;
        }
      },
      onError: (error) => {
        options.writeStderr?.(`[observer:${error.source}] ${error.message}\n`);
      },
    });
    await observerRuntime.start();
    for await (const event of attached.events()) {
      if (event.type === 'error') {
        const payload = event.payload as { code?: unknown };
        if (typeof payload.code === 'string') providerErrorCode = payload.code;
      }
      if (event.type === 'command_started') {
        const payload = event.payload as { commandKind?: string; commandName?: string };
        const commandId = event.id;
        if (
          observerRuntime.observeCommandStarted({
            id: commandId,
            commandName: payload.commandName ?? payload.commandKind ?? 'unknown command',
            startedAt: event.timestamp,
          }) !== undefined
        ) {
          activeCommandIds.push(commandId);
        }
      } else if (event.type === 'command_finished') {
        const payload = event.payload as { exitCode: number };
        const commandId = activeCommandIds.shift();
        if (commandId !== undefined) {
          observerRuntime.observeCommandFinished({
            id: commandId,
            exitCode: payload.exitCode,
            endedAt: event.timestamp,
          });
        }
      } else if (event.type === 'session_finished') {
        const payload = event.payload as { exitCode?: number };
        observerRuntime.notifyProcessExit(payload.exitCode, undefined, event.timestamp);
      }
      state = reduceSessionState(state, event);
      const progress = computeProgress({
        state,
        capabilities: adapter.capabilities(),
        now: event.timestamp,
        lastSignalAt: event.timestamp,
      });
      state = {
        ...state,
        progress,
        eta: estimateEta({
          state,
          progress,
          elapsedSeconds: Math.max(0, (event.timestamp - startedAt) / 1_000),
          history: etaHistory,
        }),
      };
      repository.appendEvent(event, state, event.timestamp);
      if (state.eta !== undefined && shouldPersistEtaSnapshot(event.type, lastEtaSnapshot)) {
        repository.saveEtaSnapshot(sessionId, state.eta, event.timestamp);
        lastEtaSnapshot = state.eta;
      }
      eventCount += 1;
    }
    const exitCode = state.status === 'completed' ? 0 : state.status === 'interrupted' ? 130 : 1;
    const failure = classifyWorkerFailure({
      provider: options.adapter,
      status:
        state.status === 'completed'
          ? 'completed'
          : state.status === 'interrupted'
            ? 'interrupted'
            : 'failed',
      exitCode,
      ...(providerErrorCode === undefined ? {} : { errorCode: providerErrorCode }),
      diagnostic: stderrChunks.join('\n'),
    });
    return {
      sessionId,
      status: state.status,
      exitCode,
      eventCount,
      ...(failure === undefined ? {} : { failure }),
    };
  } finally {
    signals.removeListener('SIGINT', handleSignal);
    signals.removeListener('SIGTERM', handleSignal);
    observerRuntime?.stop();
    await attached?.detach();
    storage.client.close();
  }
}

function ensureStorageDirectory(filename: string): void {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}
