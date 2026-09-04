import { isAgentEvent } from '@agentscope/protocol';
import type { AgentEvent } from '@agentscope/protocol';

import type { EventBus } from './event-bus.js';

export const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type SequencedAgentEvent = AgentEvent & { readonly seq: number };

export interface EventIngestionOptions {
  readonly bus: EventBus;
  readonly hasSession: (sessionId: string) => boolean | Promise<boolean>;
  readonly persist: (event: SequencedAgentEvent) => Promise<void>;
  readonly now?: () => number;
  readonly maxFutureSkewMs?: number;
}

export type RejectionReason =
  'invalid_event' | 'unknown_session' | 'invalid_timestamp' | 'duplicate_event_id';

export type IngestResult =
  | {
      readonly accepted: true;
      readonly event: SequencedAgentEvent;
      readonly publishErrors: readonly unknown[];
    }
  | {
      readonly accepted: false;
      readonly reason: RejectionReason;
      readonly existing?: SequencedAgentEvent;
    };

interface EventIdRecord {
  readonly event: SequencedAgentEvent;
}

/** Validates, sequences, persists, and then publishes normalized events. */
export class EventIngestionPipeline {
  private readonly bus: EventBus;
  private readonly hasSession: EventIngestionOptions['hasSession'];
  private readonly persist: EventIngestionOptions['persist'];
  private readonly now: () => number;
  private readonly maxFutureSkewMs: number;
  private readonly nextSeqBySession = new Map<string, number>();
  private readonly eventIds = new Map<string, EventIdRecord>();
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(options: EventIngestionOptions) {
    this.bus = options.bus;
    this.hasSession = options.hasSession;
    this.persist = options.persist;
    this.now = options.now ?? Date.now;
    this.maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    if (!Number.isFinite(this.maxFutureSkewMs) || this.maxFutureSkewMs < 0) {
      throw new Error('maxFutureSkewMs must be a non-negative finite number.');
    }
  }

  async ingest(value: unknown): Promise<IngestResult> {
    if (!isAgentEvent(value)) {
      return { accepted: false, reason: 'invalid_event' };
    }

    return this.enqueue(value.sessionId, async () => this.ingestValidated(value));
  }

  private async ingestValidated(event: AgentEvent): Promise<IngestResult> {
    if (!(await this.hasSession(event.sessionId))) {
      return { accepted: false, reason: 'unknown_session' };
    }

    if (!Number.isFinite(event.timestamp) || event.timestamp > this.now() + this.maxFutureSkewMs) {
      return { accepted: false, reason: 'invalid_timestamp' };
    }

    const existingRecord = this.eventIds.get(event.id);
    if (existingRecord !== undefined) {
      return {
        accepted: false,
        reason: 'duplicate_event_id',
        existing: existingRecord.event,
      };
    }

    const seq = (this.nextSeqBySession.get(event.sessionId) ?? 0) + 1;
    const sequencedEvent: SequencedAgentEvent = { ...event, seq };
    await this.persist(sequencedEvent);
    this.nextSeqBySession.set(event.sessionId, seq);
    this.eventIds.set(event.id, { event: sequencedEvent });
    const publishResult = await this.bus.publish(sequencedEvent);

    return {
      accepted: true,
      event: sequencedEvent,
      publishErrors: publishResult.errors,
    };
  }

  private async enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionQueues.set(sessionId, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === current) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }
}
