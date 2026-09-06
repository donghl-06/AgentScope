# AgentScope V0 Acceptance Matrix

Status is based on repository tests and the Windows native PowerShell evidence
recorded on 2026-09-06. `Partial` means the supported V0 path is verified but a
documented limitation or manual-only portion remains.

| ID | Acceptance condition | Status | Evidence |
| --- | --- | --- | --- |
| AC-01 | `agent-scope start` makes the server and Dashboard reachable | Pass | `apps/cli/src/start-runtime.test.ts`; isolated Windows start smoke on ports 8788/5174; `docs/findings/e2e.md` |
| AC-02 | Two Mock sessions can be persisted and projected together | Pass | `packages/server` integration coverage and `pnpm benchmark:mock` result in `docs/findings/e2e.md` |
| AC-03 | One real Claude and one real Codex session can be monitored | Pass | `docs/findings/claude-code.md`, `docs/findings/codex-cli.md`, `docs/findings/e2e.md` |
| AC-04 | Important event latency is below the V0 target | Partial | Architecture target is documented; a repeatable P50/P95 measurement is still pending |
| AC-05 | Completed, failed, interrupted, and blocked are not conflated | Pass | reducer, provider-runner, observer-runtime and failure/interrupt tests |
| AC-06 | Progress includes value, confidence and reasons and is capped before validation | Pass | `packages/progress` unit tests and Mock E2E |
| AC-07 | ETA includes range, confidence and reasons and widens for risk | Pass | `packages/eta` unit tests and Mock E2E |
| AC-08 | SQLite history survives a server restart | Pass | server-recovery integration test and 2026-09-06 same-database restart acceptance |
| AC-09 | Dashboard refresh/WS catch-up does not duplicate or lose timeline events | Pass | HTTP cursor catch-up tests, user-confirmed Dashboard refresh/reconnect, and 2026-09-06 isolated real WS disconnect/catch-up smoke |
| AC-10 | ExampleAdapter does not require core/storage/dashboard changes | Pass | `docs/adapter-guide.md`, protocol/core boundary tests |

## Supported V0 matrix

| Environment | Level | Notes |
| --- | --- | --- |
| Windows native PowerShell | Supported | Real Claude/Codex smoke, Unicode/space paths, and process-tree cleanup verified |
| WSL2 | Experimental / blocked | WSL2 is installed, but the current Ubuntu has Node 18 and a Windows pnpm shim; install Linux Node 22+ and pnpm before smoke |
| macOS/Linux | Experimental | Shared TypeScript tests are expected to run, but no release smoke evidence is claimed |

## Release gate

The matrix is a release record, not a claim that every partial item is solved.
Partial items are carried into `docs/known-issues.md` and the roadmap instead
of being hidden behind a green aggregate status.
