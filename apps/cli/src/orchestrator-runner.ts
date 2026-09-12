import { randomUUID } from 'node:crypto';

import {
  OrchestratorEngine,
  SerialWorkerRuntime,
  type GoalRunResult,
  type WorkerLaunchRequest,
} from '@agentscope/orchestrator';
import { openStorage, OrchestratorRepository, type CreateGoalInput } from '@agentscope/storage';

import { runProvider, type ProviderRunResult } from './provider-runner.js';

export type OrchestratorProvider = 'claude' | 'codex' | 'codex-app-server';

export interface OrchestratorRunOptions {
  readonly filename: string;
  readonly workspacePath: string;
  readonly provider: OrchestratorProvider;
  readonly prompt: string;
  readonly id?: string;
  readonly maxSteps?: number;
  readonly executable?: string;
}

export async function runOrchestrator(options: OrchestratorRunOptions): Promise<GoalRunResult> {
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new OrchestratorRepository(storage.client);
  const worker = new SerialWorkerRuntime({
    launch: async (request) => runWorker(options, request),
  });
  const engine = new OrchestratorEngine({
    repository,
    worker,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
  const input: CreateGoalInput = {
    id: options.id ?? randomUUID(),
    workspace: options.workspacePath,
    prompt: options.prompt,
    provider: options.provider,
  };
  try {
    return await engine.createGoalAndRun(input);
  } finally {
    storage.client.close();
  }
}

async function runWorker(
  options: OrchestratorRunOptions,
  request: WorkerLaunchRequest,
): Promise<{
  readonly attemptId: string;
  readonly sessionId?: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly exitCode: number;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly reportedVerification: Readonly<Record<string, unknown>>;
}> {
  const result = await runProvider({
    adapter: options.provider,
    args: providerArgs(options.provider, request.prompt),
    filename: options.filename,
    workspacePath: options.workspacePath,
    ...(options.executable === undefined ? {} : { executable: options.executable }),
  });
  return workerResult(request, result);
}

function providerArgs(provider: OrchestratorProvider, prompt: string): readonly string[] {
  if (provider === 'claude') {
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  }
  return [prompt];
}

function workerResult(
  request: WorkerLaunchRequest,
  result: ProviderRunResult,
): {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly exitCode: number;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly reportedVerification: Readonly<Record<string, unknown>>;
} {
  return {
    attemptId: request.attemptId,
    sessionId: result.sessionId,
    status:
      result.status === 'completed'
        ? 'completed'
        : result.status === 'interrupted'
          ? 'interrupted'
          : 'failed',
    exitCode: result.exitCode,
    summary: `Provider session ${result.sessionId} finished with ${result.eventCount} normalized events.`,
    changedFiles: [],
    reportedVerification: {
      providerExitCode: result.exitCode,
      normalizedEventCount: result.eventCount,
    },
  };
}
