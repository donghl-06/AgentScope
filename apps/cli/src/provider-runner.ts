import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { reduceSessionState } from '@agentscope/core';
import { ClaudeCodeAdapter } from '@agentscope/adapter-claude-code';
import { estimateEta } from '@agentscope/eta';
import { createInitialSessionState, type SessionState } from '@agentscope/protocol';
import { computeProgress } from '@agentscope/progress';
import { openStorage, StorageRepository } from '@agentscope/storage';

export interface ProviderRunOptions {
  readonly adapter: 'claude';
  readonly args: readonly string[];
  readonly filename: string;
  readonly workspacePath: string;
  readonly executable?: string;
  readonly sessionId?: string;
  readonly writeStdout?: (chunk: string) => void;
  readonly writeStderr?: (chunk: string) => void;
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
}

export async function runProvider(options: ProviderRunOptions): Promise<ProviderRunResult> {
  if (options.adapter !== 'claude') throw new Error(`Unsupported adapter: ${options.adapter}`);
  ensureStorageDirectory(options.filename);
  const now = options.now ?? Date.now;
  const sessionId = options.sessionId ?? randomUUID();
  const startedAt = now();
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new StorageRepository(storage.client);
  let state = createInitialSessionState(sessionId, startedAt);
  const adapter = new ClaudeCodeAdapter({
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    now,
    ...(options.writeStdout === undefined ? {} : { onStdout: options.writeStdout }),
    ...(options.writeStderr === undefined ? {} : { onStderr: options.writeStderr }),
  });

  repository.createSession({
    id: sessionId,
    provider: 'claude',
    adapter: 'claude-code',
    startedAt,
    capabilities: { ...adapter.capabilities() },
    workspace: { rootPath: options.workspacePath },
    state,
    now: startedAt,
  });

  let eventCount = 0;
  let attached: Awaited<ReturnType<NonNullable<ClaudeCodeAdapter['start']>>> | undefined;
  const signals = options.signals ?? process;
  const handleSignal = () => {
    void attached?.stop('user_requested');
  };
  try {
    attached = await adapter.start({
      sessionId,
      workspacePath: options.workspacePath,
      args: options.args,
    });
    signals.once('SIGINT', handleSignal);
    signals.once('SIGTERM', handleSignal);
    for await (const event of attached.events()) {
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
        }),
      };
      repository.appendEvent(event, state, event.timestamp);
      eventCount += 1;
    }
    return {
      sessionId,
      status: state.status,
      exitCode: state.status === 'completed' ? 0 : state.status === 'interrupted' ? 130 : 1,
      eventCount,
    };
  } finally {
    signals.removeListener('SIGINT', handleSignal);
    signals.removeListener('SIGTERM', handleSignal);
    await attached?.detach();
    storage.client.close();
  }
}

function ensureStorageDirectory(filename: string): void {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}
