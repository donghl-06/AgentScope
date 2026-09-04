# ADR-0005: Keep raw Agent data storage off by default

- Status: Accepted
- Date: 2026-09-05

## Context

Raw provider output can contain prompts, model messages, source code, paths, command output, credentials, and undocumented private fields. Normal operation needs normalized evidence, not complete transcripts.

## Decision

Do not persist complete stdout/stderr, raw structured events, prompts, file contents, diffs, environments, or private reasoning by default. Store normalized minimal AgentEvent payloads. A `rawRef` is absent unless a future explicit diagnostic opt-in satisfies `docs/privacy.md`.

## Consequences

- Adapters parse streaming data without automatically retaining it.
- Server logs never duplicate wrapped Agent stdout.
- Parser errors log redacted metadata, not the raw record.
- Real fixtures are minimized, sanitized, secret-scanned, and reviewed.
- If raw diagnostics are implemented, they require bounded retention, size limits, a deletion procedure, and tests proving default-off behavior.

## References

- `docs/privacy.md`
- `AgentScope_Codex实施规格.md`
