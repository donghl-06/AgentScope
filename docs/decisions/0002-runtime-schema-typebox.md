# ADR-0002: Use TypeBox/JSON Schema for runtime contracts

- Status: Accepted
- Date: 2026-09-05

## Context

Agent events cross untrusted provider, fixture, database, HTTP, and WebSocket boundaries. TypeScript types alone cannot validate runtime data. The same contract should support static inference, API validation, serialization, and protocol documentation.

## Decision

Define cross-boundary V0 schemas with TypeBox-compatible JSON Schema and infer TypeScript types from those schemas. Use the official Fastify TypeBox provider at the HTTP boundary.

## Rationale

- One schema can drive runtime validation and TypeScript inference.
- JSON Schema is transport-neutral and can support future non-TypeScript collectors.
- Fastify officially documents a TypeBox type provider.
- Golden serialized fixtures can detect accidental protocol changes.

## Consequences

- Protocol schemas are the source of truth; duplicate handwritten interfaces are avoided.
- Custom formats and recursive/ref schemas require explicit registration and tests.
- Domain-only internal types may remain plain TypeScript when they never cross a runtime boundary.
- Exact TypeBox package/API names are verified during Step 1.1 because the ecosystem has changed major versions.

## References

- https://fastify.dev/docs/latest/Reference/Type-Providers/
- https://fastify.dev/docs/latest/Reference/TypeScript/
