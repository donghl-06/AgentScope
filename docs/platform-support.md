# V0 Platform and Support Baseline

Status: Phase 0 baseline; capability claims remain experimental until the relevant smoke test passes.

## 1. Target matrix

| Area | V0 target | Verification level |
|---|---|---|
| Primary OS | Windows 11 native | Full Mock E2E, CLI/process tests, real Claude and Codex smoke |
| Secondary OS | WSL2 Linux, otherwise a documented Linux/macOS runner | Mock E2E plus CLI/process smoke |
| Node.js | Node.js 22+; CI will cover the selected minimum line and the active development line | Install, lint, typecheck, unit/integration test, build |
| Package manager | pnpm workspace with a committed lockfile and pinned packageManager field | Clean-install CI |
| Claude Code | The exact versions verified in Phase 0 fixtures; other versions capability-detected | Fixture tests plus manual smoke |
| Codex CLI | The exact versions verified in Phase 0 fixtures; other versions capability-detected | Fixture tests plus manual smoke |

“Target” is not a support claim. A matrix entry becomes supported only after its documented smoke checklist passes. Untested environments are labeled experimental.

## 2. Development environment observed on 2026-09-05

| Item | Observed value |
|---|---|
| OS | Microsoft Windows NT 10.0.26200.0 |
| Node.js | v24.14.1 |
| pnpm | 11.19.0 |
| Claude Code CLI | 2.1.259 |
| Codex CLI | 0.152.1 |
| WSL | Installed status could not be enumerated from the current sandbox due to access denial; verify in Step 0.4 |

These versions describe the current workstation, not a hardcoded adapter contract. Phase 0 fixtures record the exact provider version that produced each sample.

## 3. Definition of supported

An Agent/OS mode is “supported” only when all applicable evidence exists:

1. Detection reports the installed executable and version or a clear actionable error.
2. A sanitized raw fixture covers success, failure, and interruption.
3. Raw fixture to normalized AgentEvent golden tests pass.
4. Process stdio, exit code, signal, and cleanup behavior pass the target platform smoke checklist.
5. At least one real session reaches the Dashboard.
6. Known missing capabilities and fallback observers are documented.
7. The mode does not require OCR, GUI scraping, private reasoning, or an undocumented internal event as its only signal.

## 4. Capability language

- **Native:** confirmed structured public interface; highest potential confidence.
- **Wrapped:** AgentScope owns the process and can use lifecycle/output/workspace signals.
- **External:** workspace/process evidence without a stable native session interface.
- **Experimental:** observed but not yet covered by the full support evidence above.
- **Unavailable:** confirmed absent or intentionally excluded.

Capability is recorded independently for structured events, tool calls, file events, command events, token usage, session info, and milestones.

## 5. CI and manual boundaries

Default CI:

- never requires installed Claude Code or Codex CLI;
- uses MockAdapter and sanitized fixtures;
- runs protocol, reducer, storage, API, realtime, Progress, ETA, and Dashboard tests.

Opt-in/manual jobs:

- real provider CLI smoke;
- interactive terminal behavior;
- Ctrl+C/process-tree behavior per OS;
- WSL/Windows path translation;
- provider-version fixture refresh.

## 6. Version-change policy

- Provider event names are never assumed stable merely because an older fixture contains them.
- An adapter parser change requires a fixture and golden normalized output.
- Unknown versions may run through conservative fallback when safe; they must not silently claim rich capabilities.
- Breaking provider behavior opens a new capability spike and updates findings before parser work.
- Node/pnpm/dependency upgrades run the full clean-install and Mock E2E gates.

## 7. Open verification items

| Item | Due Step | Close condition |
|---|---|---|
| WSL distribution and version | 0.4 | Read-only environment check and process/path smoke |
| Minimum exact Node 22 minor | 1.1 | Selected SQLite driver and all dependencies install/test without experimental flags |
| Interactive PTY requirement | 0.2–0.4 | Real CLI experiment documents stdin/stdout/structured compatibility |
| macOS/Linux beyond WSL | 12.6 | Named runner and completed smoke checklist, or explicitly experimental |
