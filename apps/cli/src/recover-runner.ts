import { openStorage, StorageRepository } from '@agentscope/storage';

export interface RecoverySummary {
  readonly recovered: readonly RecoverySession[];
  readonly count: number;
}

export interface RecoverySession {
  readonly id: string;
  readonly status: 'interrupted';
  readonly endedAt?: number;
}

/** Mark stale starting/running sessions as interrupted using the storage recovery policy. */
export function recoverSessions(filename: string, now = Date.now): RecoverySummary {
  const storage = openStorage({ filename, migrate: true });
  try {
    const repository = new StorageRepository(storage.client);
    const recovered = repository.recoverInFlightSessions(now());
    const sessions = recovered.map((session) => ({
      id: session.id,
      status: 'interrupted' as const,
      ...(session.state.endedAt === undefined ? {} : { endedAt: session.state.endedAt }),
    }));
    return { recovered: sessions, count: sessions.length };
  } finally {
    storage.client.close();
  }
}
