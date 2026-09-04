import type { AgentEvent } from '@agentscope/protocol';

export type EventListener = (event: AgentEvent) => void | Promise<void>;
export type EventUnsubscribe = () => void;

export interface PublishResult {
  readonly delivered: number;
  readonly errors: readonly unknown[];
}

export interface EventBusOptions {
  readonly onListenerError?: (error: unknown, event: AgentEvent) => void | Promise<void>;
}

interface Subscription {
  readonly listener: EventListener;
}

/**
 * In-process event delivery for Core.
 *
 * `publish` awaits listeners in subscription order. This provides explicit backpressure and
 * deterministic delivery while isolating listener failures so one consumer cannot stop others.
 */
export class EventBus {
  private readonly globalSubscriptions = new Set<Subscription>();
  private readonly sessionSubscriptions = new Map<string, Set<Subscription>>();
  private readonly onListenerError?: EventBusOptions['onListenerError'];
  private closed = false;

  constructor(options: EventBusOptions = {}) {
    this.onListenerError = options.onListenerError;
  }

  subscribe(listener: EventListener, sessionId?: string): EventUnsubscribe {
    if (this.closed) {
      throw new Error('EventBus is closed.');
    }

    const subscription: Subscription = { listener };
    const subscriptions =
      sessionId === undefined ? this.globalSubscriptions : this.getSessionSet(sessionId);
    subscriptions.add(subscription);

    return () => {
      subscriptions.delete(subscription);
      if (sessionId !== undefined && subscriptions.size === 0) {
        this.sessionSubscriptions.delete(sessionId);
      }
    };
  }

  async publish(event: AgentEvent): Promise<PublishResult> {
    if (this.closed) {
      throw new Error('EventBus is closed.');
    }

    const sessionSubscriptions = this.sessionSubscriptions.get(event.sessionId);
    const subscriptions = [
      ...this.globalSubscriptions,
      ...(sessionSubscriptions === undefined ? [] : sessionSubscriptions),
    ];
    const errors: unknown[] = [];

    for (const subscription of subscriptions) {
      try {
        await subscription.listener(event);
      } catch (error) {
        errors.push(error);
        if (this.onListenerError !== undefined) {
          try {
            await this.onListenerError(error, event);
          } catch (diagnosticError) {
            errors.push(diagnosticError);
          }
        }
      }
    }

    return { delivered: subscriptions.length, errors };
  }

  clear(): void {
    this.globalSubscriptions.clear();
    this.sessionSubscriptions.clear();
  }

  close(): void {
    this.clear();
    this.closed = true;
  }

  private getSessionSet(sessionId: string): Set<Subscription> {
    const existing = this.sessionSubscriptions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const created = new Set<Subscription>();
    this.sessionSubscriptions.set(sessionId, created);
    return created;
  }
}
