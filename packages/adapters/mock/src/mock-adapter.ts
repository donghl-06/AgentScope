import { type AgentEvent } from '@agentscope/protocol';
import type {
  AgentAdapter,
  AgentCapabilities,
  AttachedSession,
  DetectionResult,
  StartAgentRequest,
  Unsubscribe,
} from '@agentscope/adapter-base';

import {
  getMockFixture,
  MOCK_FIXTURES,
  type MockFixture,
  type MockFixtureName,
} from './fixtures.js';

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

class MockAttachedSession implements AttachedSession {
  readonly pid = undefined;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private stopped = false;
  private runTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fixture: MockFixture,
    private readonly sessionId: string,
    private readonly startedAt: number,
    private readonly speed: number,
  ) {
    this.runTimer = setTimeout(() => {
      this.runTimer = undefined;
      void this.run();
    }, 0);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): Unsubscribe {
    if (this.stopped) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    this.queue.end();
  }

  async detach(): Promise<void> {
    this.stopped = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    this.listeners.clear();
    this.queue.end();
  }

  private async run(): Promise<void> {
    let previousAtMs = 0;
    for (const [index, step] of this.fixture.steps.entries()) {
      if (this.stopped) break;
      const delayMs = Math.max(0, step.atMs - previousAtMs);
      previousAtMs = step.atMs;
      if (this.speed > 0 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs / this.speed));
      }
      if (this.stopped) break;
      const event: AgentEvent = {
        id: `${this.sessionId}-${index + 1}`,
        sessionId: this.sessionId,
        timestamp: this.startedAt + step.atMs,
        source: { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' },
        type: step.type,
        payload: step.payload,
        confidence: step.confidence ?? 1,
      };
      this.queue.push(event);
      for (const listener of this.listeners) {
        try {
          await listener(event);
        } catch {
          // Subscriber failures must not stop the fixture stream.
        }
      }
    }
    this.queue.end();
  }
}

export interface MockAdapterOptions {
  readonly fixture?: MockFixtureName;
  readonly speed?: number;
  readonly now?: () => number;
}

const FULL_CAPABILITIES: AgentCapabilities = {
  structuredEvents: true,
  toolCalls: true,
  fileEvents: true,
  commandEvents: true,
  tokenUsage: false,
  sessionInfo: true,
  milestones: true,
};

const LOW_SIGNAL_CAPABILITIES: AgentCapabilities = {
  structuredEvents: false,
  toolCalls: false,
  fileEvents: false,
  commandEvents: false,
  tokenUsage: false,
  sessionInfo: true,
  milestones: false,
};

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  private readonly fixture: MockFixtureName | undefined;
  private readonly speed: number;
  private readonly now: () => number;

  constructor(options: MockAdapterOptions = {}) {
    this.fixture = options.fixture;
    this.speed = options.speed ?? 1;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.speed) || this.speed < 0) {
      throw new Error('Mock adapter speed must be a non-negative finite number.');
    }
  }

  async detect(): Promise<DetectionResult> {
    return { available: true, confidence: 1, version: '0.1.0' };
  }

  capabilities(): AgentCapabilities {
    return this.fixture === 'low-signal' ? LOW_SIGNAL_CAPABILITIES : FULL_CAPABILITIES;
  }

  async start(request: StartAgentRequest): Promise<AttachedSession> {
    const fixtureArgIndex = request.args.indexOf('--fixture');
    const fixtureName =
      this.fixture ??
      (fixtureArgIndex >= 0 ? request.args[fixtureArgIndex + 1] : undefined) ??
      'basic-success';
    return new MockAttachedSession(
      getMockFixture(fixtureName),
      request.sessionId,
      this.now(),
      this.speed,
    );
  }
}

export function listMockFixtures(): readonly MockFixtureName[] {
  return Object.keys(MOCK_FIXTURES) as MockFixtureName[];
}
