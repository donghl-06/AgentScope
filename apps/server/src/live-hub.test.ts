import { describe, expect, it } from 'vitest';

import { LiveHub, type LiveSocket } from './live-hub.js';

class FakeSocket implements LiveSocket {
  readonly messages: string[] = [];
  closed = false;
  send(payload: string): void {
    if (this.closed) throw new Error('closed');
    this.messages.push(payload);
  }
  close(): void {
    this.closed = true;
  }
}

describe('LiveHub', () => {
  it('sends hello, applies subscriptions, and filters notifications', () => {
    const hub = new LiveHub();
    const first = new FakeSocket();
    const second = new FakeSocket();
    hub.attach(first);
    hub.attach(second);
    hub.handleMessage(first, JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    hub.publish({ type: 'event.appended', sessionId: 'session-1', seq: 1 });
    hub.publish({ type: 'event.appended', sessionId: 'session-2', seq: 1 });

    expect(JSON.parse(first.messages[0]!)).toEqual({ type: 'hello', protocolVersion: '0.1' });
    expect(JSON.parse(first.messages[1]!)).toMatchObject({ type: 'subscribed' });
    expect(first.messages).toHaveLength(3);
    expect(second.messages).toHaveLength(3);
    expect(JSON.parse(first.messages[2]!)).toMatchObject({ sessionId: 'session-1' });
    expect(JSON.parse(second.messages[2]!)).toMatchObject({ sessionId: 'session-2' });
  });

  it('supports ping and removes clients whose send fails', () => {
    const hub = new LiveHub();
    const socket = new FakeSocket();
    hub.attach(socket);
    hub.handleMessage(socket, JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(socket.messages.at(-1)!)).toEqual({ type: 'pong' });
    socket.closed = true;
    hub.publish({ type: 'project.updated', projectId: 'project-1' });
    expect(hub.clientCount).toBe(0);
  });

  it('returns protocol errors for malformed and unsupported client messages', () => {
    const hub = new LiveHub();
    const socket = new FakeSocket();
    hub.attach(socket);

    hub.handleMessage(socket, '{');
    expect(JSON.parse(socket.messages.at(-1)!)).toEqual({ type: 'error', code: 'invalid_json' });
    hub.handleMessage(socket, JSON.stringify({ type: 'unknown' }));
    expect(JSON.parse(socket.messages.at(-1)!)).toEqual({
      type: 'error',
      code: 'unsupported_message',
    });
    expect(hub.diagnostics()).toMatchObject({ invalidMessages: 1, unsupportedMessages: 1 });
  });

  it('reports notification delivery and failed-send diagnostics', () => {
    const hub = new LiveHub();
    const healthy = new FakeSocket();
    const broken = new FakeSocket();
    hub.attach(healthy);
    hub.attach(broken);
    broken.closed = true;

    hub.publish({ type: 'event.appended', sessionId: 'session-1', seq: 1 });

    expect(hub.diagnostics()).toMatchObject({
      clientCount: 1,
      notificationsPublished: 1,
      notificationsDelivered: 1,
      sendFailures: 1,
    });
  });

  it('closes all clients when the hub shuts down', () => {
    const hub = new LiveHub();
    const first = new FakeSocket();
    const second = new FakeSocket();
    hub.attach(first);
    hub.attach(second);

    hub.close();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(hub.clientCount).toBe(0);
  });

  it('removes clients that do not answer heartbeat probes', () => {
    const hub = new LiveHub();
    const socket = new FakeSocket();
    hub.attach(socket);

    hub.heartbeat();
    expect(JSON.parse(socket.messages.at(-1)!)).toEqual({ type: 'ping' });
    hub.handleMessage(socket, JSON.stringify({ type: 'pong' }));
    hub.heartbeat();
    expect(hub.clientCount).toBe(1);
    hub.heartbeat();
    expect(hub.clientCount).toBe(0);
    expect(socket.closed).toBe(true);
  });
});
