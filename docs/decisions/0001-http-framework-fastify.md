# ADR-0001: Use Fastify for the local HTTP server

- Status: Accepted
- Date: 2026-09-05

## Context

The V0 server needs typed HTTP routes, runtime request/response validation, lifecycle hooks, test injection, structured logging, and a maintained WebSocket integration. It must stay a transport composition layer rather than absorb Core logic.

## Decision

Use Fastify v5 as the HTTP framework. Route schemas use the shared Protocol JSON Schemas, and application composition is expressed through small Fastify plugins.

## Rationale

- Fastify v5 supports Node.js 20+, below AgentScope''s Node.js 22+ baseline.
- Fastify uses JSON Schema validation/serialization and has official type-provider support.
- `inject`-style testing and plugin lifecycle hooks fit API integration and cleanup tests.
- `@fastify/websocket` provides an aligned realtime transport without introducing a second HTTP server.

## Consequences

- Full JSON Schema is required for route bodies, params, queries, and responses.
- Core cannot import Fastify types.
- Fastify log serializers/redaction must comply with `docs/privacy.md`.
- Exact dependency versions are pinned by the Phase 1 lockfile, not this ADR.

## References

- https://fastify.dev/docs/latest/Reference/TypeScript/
- https://fastify.dev/docs/latest/Reference/Type-Providers/
- https://fastify.dev/docs/v5.3.x/Guides/Migration-Guide-V5/
