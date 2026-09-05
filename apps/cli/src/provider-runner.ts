import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { reduceSessionState } from '@agentscope/core';
import { ClaudeCodeAdapter } from '@agentscope/adapter-claude-code';
import { createInitialSessionState, type SessionState } from '@agentscope/protocol';
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
  try {
    attached = await adapter.start({
      sessionId,
      workspacePath: options.workspacePath,
      args: options.args,
    });
    for await (const event of attached.events()) {
      state = reduceSessionState(state, event);
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
    await attached?.detach();
    storage.client.close();
  }
}

function ensureStorageDirectory(filename: string): void {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}
