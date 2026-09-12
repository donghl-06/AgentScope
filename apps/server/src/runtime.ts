import fs from 'node:fs';
import path from 'node:path';

import {
  openStorage,
  OrchestratorRepository,
  StorageRepository,
  type OpenStorageResult,
} from '@agentscope/storage';
import { recoverOrchestrator } from '@agentscope/orchestrator';
import type { OrchestratorEngine } from '@agentscope/orchestrator';

import { createServer, type ServerOptions } from './index.js';

export interface StartServerOptions extends Omit<ServerOptions, 'repository'> {
  readonly filename: string;
  readonly host: string;
  readonly port: number;
  readonly orchestratorEngineFactory?: (repository: OrchestratorRepository) => OrchestratorEngine;
}

export interface RunningServer {
  readonly address: string;
  readonly close: () => Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  ensureStorageDirectory(options.filename);
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new StorageRepository(storage.client);
  const orchestratorRepository =
    options.orchestratorRepository ?? new OrchestratorRepository(storage.client);
  if (options.recoverOnStart !== false) recoverOrchestrator(orchestratorRepository);
  const orchestratorEngine =
    options.orchestratorEngine ?? options.orchestratorEngineFactory?.(orchestratorRepository);
  const app = createServer({
    ...options,
    repository,
    orchestratorRepository,
    ...(orchestratorEngine === undefined ? {} : { orchestratorEngine }),
  });
  let closed = false;
  try {
    const address = await app.listen({ host: options.host, port: options.port });
    const close = async () => {
      if (closed) return;
      closed = true;
      await closeResources(app, storage);
    };
    return { address, close };
  } catch (error) {
    await closeResources(app, storage);
    throw error;
  }
}

function ensureStorageDirectory(filename: string): void {
  if (filename === ':memory:') return;
  const directory = path.dirname(path.resolve(filename));
  fs.mkdirSync(directory, { recursive: true });
}

async function closeResources(
  app: ReturnType<typeof createServer>,
  storage: OpenStorageResult,
): Promise<void> {
  try {
    await app.close();
  } finally {
    storage.client.close();
  }
}
