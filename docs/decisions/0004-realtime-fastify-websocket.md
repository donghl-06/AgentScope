# ADR-0004: Use WebSocket for live notifications and HTTP cursors for recovery

- Status: Accepted
- Date: 2026-09-05

## Context

The Dashboard needs low-latency updates, but local sockets can disconnect and messages can be dropped. Treating a WebSocket connection as durable state would make timeline correctness dependent on connection quality.

## Decision

Use `@fastify/websocket` for the `/ws` live channel. Persist events first and attach session sequence/cursor metadata to notifications. Use HTTP `events?after=<cursor>` as the authoritative catch-up path.

## Consequences

- Dashboard performs HTTP snapshot, opens WebSocket, detects sequence gaps, and catches up through HTTP.
- Clients deduplicate by session/sequence.
- Slow-client policy, heartbeat, message size, and cleanup are tested.
- WebSocket messages remain compact notifications; large timeline payloads use HTTP pagination.
- The server can restart without making persisted events unreachable.

## References

- https://github.com/fastify/fastify-websocket
