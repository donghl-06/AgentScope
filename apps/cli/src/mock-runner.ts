import { reduceSessionState } from '@agentscope/core';
import { MockAdapter, type MockFixtureName } from '@agentscope/adapter-mock';
import { estimateEta } from '@agentscope/eta';
import { createInitialSessionState, type SessionState } from '@agentscope/protocol';
import { computeProgress } from '@agentscope/progress';
import { openStorage, StorageRepository } from '@agentscope/storage';

import { shouldPersistEtaSnapshot } from './eta-snapshot.js';

export interface MockRunOptions {
  readonly filename: string;
  readonly fixture: MockFixtureName;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly projectId?: string;
  readonly speed?: number;
  readonly now?: () => number;
}

export interface MockRunResult {
  readonly sessionId: string;
  readonly status: SessionState['status'];
  readonly exitCode: number;
  readonly eventCount: number;
}

export async function runMockFixture(options: MockRunOptions): Promise<MockRunResult> {
  const startedAt = options.now?.() ?? Date.now();
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new StorageRepository(storage.client);
  let state = createInitialSessionState(options.sessionId, startedAt);
  repository.createSession({
    id: options.sessionId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    provider: 'mock',
    adapter: 'mock',
    startedAt,
    capabilities: { ...new MockAdapter({ fixture: options.fixture }).capabilities() },
    workspace: { rootPath: options.workspacePath },
    state,
    now: startedAt,
  });

  let eventCount = 0;
  let lastEtaSnapshot: SessionState['eta'];
  const adapter = new MockAdapter({
    fixture: options.fixture,
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let attached: Awaited<ReturnType<NonNullable<MockAdapter['start']>>> | undefined;
  try {
    attached = await adapter.start({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      args: [],
    });
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
      if (state.eta !== undefined && shouldPersistEtaSnapshot(event.type, lastEtaSnapshot)) {
        repository.saveEtaSnapshot(options.sessionId, state.eta, event.timestamp);
        lastEtaSnapshot = state.eta;
      }
      eventCount += 1;
    }
    const exitCode = state.status === 'completed' ? 0 : state.status === 'interrupted' ? 130 : 1;
    return { sessionId: options.sessionId, status: state.status, exitCode, eventCount };
  } finally {
    await attached?.detach();
    storage.client.close();
  }
}
