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

export interface CliOrchestratorEngineOptions {
  readonly filename: string;
  readonly repository: OrchestratorRepository;
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  readonly maxSteps?: number;
}

export async function runOrchestrator(options: OrchestratorRunOptions): Promise<GoalRunResult> {
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new OrchestratorRepository(storage.client);
  const engine = createCliOrchestratorEngine({
    filename: options.filename,
    repository,
    ...(options.executable === undefined
      ? {}
      : options.provider === 'claude'
        ? { claudeExecutable: options.executable }
        : { codexExecutable: options.executable }),
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

export function createCliOrchestratorEngine(
  options: CliOrchestratorEngineOptions,
): OrchestratorEngine {
  return new OrchestratorEngine({
    repository: options.repository,
    worker: new SerialWorkerRuntime({
      launch: async (request) => {
        const provider = toOrchestratorProvider(request.provider);
        const result = await runProvider({
          adapter: provider,
          args: providerArgs(provider, request.prompt),
          filename: options.filename,
          workspacePath: request.workspace,
          ...(provider === 'claude'
            ? options.claudeExecutable === undefined
              ? {}
              : { executable: options.claudeExecutable }
            : options.codexExecutable === undefined
              ? {}
              : { executable: options.codexExecutable }),
        });
        return workerResult(request, result);
      },
    }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
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

function toOrchestratorProvider(value: string): OrchestratorProvider {
  if (value === 'claude' || value === 'codex' || value === 'codex-app-server') return value;
  throw new Error(`Unsupported Orchestrator provider: ${value}`);
}
