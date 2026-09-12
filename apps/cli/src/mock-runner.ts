import { reduceSessionState } from '@agentscope/core';
import { MockAdapter, type MockFixtureName } from '@agentscope/adapter-mock';
import { estimateEta, type EtaHistory } from '@agentscope/eta';
import { ObserverRuntime } from '@agentscope/observer-runtime';
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
  const adapter = new MockAdapter({
    fixture: options.fixture,
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const etaHistory: EtaHistory = {
    durationsSeconds: repository
      .listEtaHistory({ provider: 'mock', adapter: adapter.id })
      .map((sample) => sample.durationSeconds),
    scope: `mock/${adapter.id}`,
  };
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
  let attached: Awaited<ReturnType<NonNullable<MockAdapter['start']>>> | undefined;
  let observerRuntime: ObserverRuntime | undefined;
  const activeCommandIds: string[] = [];
  try {
    attached = await adapter.start({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      args: [],
    });
    observerRuntime = new ObserverRuntime({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      file: {},
      onEvidence: (evidence) =>
        repository.saveObserverEvidence({
          id: evidence.id,
          sessionId: options.sessionId,
          key: evidence.key,
          timestamp: evidence.timestamp,
          source: evidence.source,
          kind: evidence.kind,
          confidence: evidence.confidence,
          reason: evidence.reason,
          payload: evidence.payload,
        }),
    });
    await observerRuntime.start();
    for await (const event of attached.events()) {
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
        repository.saveEtaSnapshot(options.sessionId, state.eta, event.timestamp);
        lastEtaSnapshot = state.eta;
      }
      eventCount += 1;
    }
    const exitCode = state.status === 'completed' ? 0 : state.status === 'interrupted' ? 130 : 1;
    return { sessionId: options.sessionId, status: state.status, exitCode, eventCount };
  } finally {
    observerRuntime?.stop();
    await attached?.detach();
    storage.client.close();
  }
}
