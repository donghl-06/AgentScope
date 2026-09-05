import { openStorage, StorageRepository, type OpenStorageResult } from '@agentscope/storage';

import { createServer, type ServerOptions } from './index.js';

export interface StartServerOptions extends Omit<ServerOptions, 'repository'> {
  readonly filename: string;
  readonly host: string;
  readonly port: number;
}

export interface RunningServer {
  readonly address: string;
  readonly close: () => Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const storage = openStorage({ filename: options.filename, migrate: true });
  const repository = new StorageRepository(storage.client);
  const app = createServer({ ...options, repository });
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
