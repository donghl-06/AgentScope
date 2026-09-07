# AgentScope V1 / Interactive TTY Roadmap

- Status: planning baseline
- Primary target: Windows 11 + VS Code PowerShell + Claude Code harness + compatible Kimi API
- Secondary target: WSL2 Ubuntu
- Starting point: V0 local-first structured/non-interactive monitoring is complete and remains the compatibility fallback.

## 1. V1 objective

V1 turns AgentScope from a wrapper for one structured prompt into a companion for normal,
long-lived Claude Code usage. The intended experience is:

```text
Terminal A: agent-scope start
Terminal B: agent-scope claude

User submits turn 1 ─┐
Claude works          ├─ AgentScope Dashboard updates in real time
User submits turn 2 ──┤
Claude works          └─ each turn keeps its own status and evidence
```

The Claude terminal must remain recognizably native: colors, cursor movement, multiline input,
approval UI, slash commands, resize and interruption should behave as they do when the user runs
`claude` directly. AgentScope observes and projects the session; it does not replace Claude Code's
conversation UI.

## 2. Product decisions already made

- [x] Use route 1 as the reliability baseline: transparent PTY/ConPTY plus process, filesystem,
      Git and verification observers.
- [x] Use route 2 as an additive enhancement: stable Claude hooks or documented side-channel
      events when available, with capability detection and graceful fallback.
- [x] Do not implement route 3: AgentScope will not build a replacement chat UI around repeated
      non-interactive provider calls.
- [x] Preserve compatibility with Claude Code using a compatible Kimi endpoint. AgentScope wraps
      the local Claude harness and does not require an Anthropic account or call an Anthropic API.
- [x] Optimize for practical local experience. User-submitted turn text may be stored locally to
      provide useful task titles and history, while obvious credentials remain redacted and raw
      chain-of-thought/provider internals remain excluded.
- [x] Keep the V0 structured path working as a fallback and for automation/CI.

## 3. V1 scope and priorities

### P0 — required for the first usable V1

- Transparent Windows ConPTY and WSL2/Linux PTY runtime.
- A new interactive CLI entry point, tentatively `agent-scope claude`.
- One terminal session containing multiple task turns.
- Per-turn lifecycle, duration, current activity, Progress, ETA and evidence.
- Correct input/output forwarding, resize, Ctrl+C, normal exit and crash recovery.
- Process, file, Git and known verification signals correlated to the active turn.
- Dashboard session/turn hierarchy and live updates.
- The existing Kimi-backed Claude Code configuration must pass through unchanged.

### P1 — experience improvements after the TTY path is stable

- Claude `--resume`/`--continue` correlation.
- Reliable waiting-for-user and blocked-state indication.
- Per-turn file changes, test results and Git commit association.
- Multiple simultaneous Claude/Codex session groups.
- Long-task desktop notification and blocker notification.
- Timeline search, filters and turn navigation.

### P2 — optional evidence-dependent improvements

- CPU, memory, process-tree and long-duration capacity metrics.
- Token/cost display only when the provider exposes stable and trustworthy values.
- Local turn summaries and searchable history.
- Trend views such as task duration and verification success rate.

### Explicit non-goals for the first V1 release

- Replacing the native Claude Code terminal or approval UI.
- Attaching reliably to an arbitrary `claude` process that was started outside AgentScope.
- Remote execution, accounts, multi-device sync or a hosted control plane.
- Persisting hidden reasoning, chain-of-thought, credentials or raw provider internals.
- Making undocumented Claude internal files the only source of truth.

## 4. Target architecture

```text
VS Code terminal
    │ keyboard, resize, Ctrl+C
    ▼
AgentScope interactive CLI
    │
    ├── PTY runtime ───────────────► Claude Code native TUI
    │       │ terminal lifecycle
    │       └──────────────────────► process evidence
    │
    ├── turn coordinator ◄───────── user input boundaries
    │       │
    │       ├── filesystem/Git/test observers
    │       └── optional Claude hooks side channel
    │
    ▼
SQLite: terminal sessions + turns + normalized events + evidence
    │
    ▼
AgentScope server ── HTTP cursor recovery + WebSocket ──► Dashboard
```

The PTY path is responsible for terminal fidelity. The observer and optional hook paths are
responsible for semantic progress. A hook outage must reduce detail, not terminate Claude or the
interactive terminal.

## 5. Data model direction

V0's session remains the top-level execution record. V1 adds a turn layer:

```text
AgentSession
├── Terminal metadata and provider session id
├── Turn 1
│   ├── submitted text/title
│   ├── lifecycle and activity
│   ├── events and evidence
│   └── verification/Progress/ETA snapshots
├── Turn 2
└── Turn N
```

Planned storage additions:

- `turns`: id, session id, sequence, title/text, status, started/ended timestamps and source.
- `turn_events` or a nullable `turn_id` on normalized events, chosen through an ADR and migration
  experiment before implementation.
- Turn-scoped observer evidence and verification snapshots.
- Provider resume identity separated from the AgentScope session id.
- Terminal capability metadata: platform, PTY driver, interactive/hook capabilities and fallbacks.

Migration must preserve every V0 database. Existing sessions without turns remain readable and
are displayed as legacy single-task sessions.

## 6. Implementation plan

### Phase 0 — freeze the interactive contract and choose the PTY driver

#### Step 0.1 — define the terminal behavior contract

- [ ] Record the exact expected behavior for colors, cursor control, multiline input, paste,
      approval screens, slash commands, resize, Ctrl+C, Ctrl+Break, EOF and normal exit.
- [ ] Define the difference between interrupting the current Claude action and terminating the
      entire interactive session.
- [ ] Define supported launch forms and pass-through argument boundaries.
- [ ] Add a decision record describing why AgentScope owns the child PTY instead of attaching to
      an unrelated already-running process.

Verification:

- A deterministic fake interactive CLI exercises the contract without a real provider.
- The contract explicitly covers Windows PowerShell, VS Code Terminal and WSL2.

Commit boundary: terminal contract, ADR and fake fixture only.

#### Step 0.2 — compare PTY/ConPTY driver options

- [ ] Evaluate maintained Node-compatible drivers for Windows ConPTY and Unix PTY support.
- [ ] Compare native build requirements, Node 22/24 compatibility, Windows ARM/x64 coverage,
      resize/signal behavior, Unicode handling, release health and supply-chain surface.
- [ ] Run a disposable proof of concept with a fake TUI on Windows and WSL2.
- [ ] Select one driver and document rejected alternatives and fallback behavior.

Verification:

- Spawn, input, output, resize and termination pass on Windows and WSL2.
- Dependency audit and clean-install experiment pass before the driver enters the main workspace.

Commit boundary: driver decision and isolated spike; no production wiring yet.

#### Step 0.3 — inspect Claude interactive and hook capabilities

- [ ] Capture a redacted capability matrix for the installed Claude Code version.
- [ ] Verify which documented hooks fire during interactive turns, tool calls, notifications and
      stop events when the harness uses the configured Kimi endpoint.
- [ ] Verify `--resume` and `--continue` identifiers and failure behavior.
- [ ] Confirm no hook is required for basic PTY operation.

Verification:

- Redacted fixtures contain shapes only, never prompt text, API keys or raw reasoning.
- Missing/changed hooks produce a declared low-capability mode.

Commit boundary: capability findings, fixtures and parser tests.

### Phase 1 — protocol and storage foundations

#### Step 1.1 — add the turn protocol

- [ ] Define `TurnStatus`, `TurnState`, `TurnStarted`, `TurnUpdated` and `TurnFinished` schemas.
- [ ] Define turn-scoped activity, verification, Progress and ETA projections.
- [ ] Version the protocol additively so V0 consumers can ignore V1 notifications.
- [ ] Add malformed, unknown-field and replay-order tests.

Verification: schema, parser and compatibility tests pass without changing V0 event meaning.

Commit boundary: protocol types and tests.

#### Step 1.2 — add backward-compatible storage migrations

- [ ] Add the turn table and indexes needed for session/sequence/time queries.
- [ ] Decide through an ADR whether events reference turns directly or through a mapping table.
- [ ] Add repositories for create/start/update/finish/list turn operations.
- [ ] Add migration, rollback/backup instructions and V0 database compatibility tests.
- [ ] Preserve transaction-before-broadcast behavior.

Verification: a copied V0 fixture database migrates and remains readable; concurrent writers and
busy-error normalization remain correct.

Commit boundary: migration, repository and storage tests.

#### Step 1.3 — implement the turn reducer

- [ ] Add deterministic lifecycle transitions for queued/running/waiting/blocked/completed/failed/
      interrupted turns.
- [ ] Prevent one recoverable tool failure from automatically overriding a later successful turn
      outcome; preserve the failed tool as evidence.
- [ ] Keep terminal-session failure separate from individual-turn failure.
- [ ] Add replay, duplicate, out-of-order and crash-recovery tests.

Verification: session and turn states remain reproducible from stored events.

Commit boundary: reducer and projection tests.

### Phase 2 — cross-platform PTY runtime

#### Step 2.1 — create a provider-neutral terminal package

- [ ] Add a package exposing spawn, write, resize, interrupt, terminate and async output APIs.
- [ ] Normalize terminal lifecycle without rewriting ANSI output.
- [ ] Bound output buffers and apply backpressure without blocking the child process.
- [ ] Keep raw terminal chunks ephemeral by default.

Verification: fake TUI tests cover fragmented UTF-8, ANSI sequences, large output and slow readers.

Commit boundary: isolated terminal package and tests.

#### Step 2.2 — implement Windows ConPTY behavior

- [ ] Preserve VS Code PowerShell input, Unicode, paste and resize.
- [ ] Distinguish Ctrl+C for the current action from full session termination where Claude permits.
- [ ] Clean the owned process tree on wrapper exit without killing unrelated processes.
- [ ] Recover stale sessions after abrupt terminal closure.

Verification: automated fake-process tests plus a manual native Windows smoke checkpoint.

Commit boundary: Windows runtime and platform tests.

#### Step 2.3 — implement WSL2/Linux PTY behavior

- [ ] Provide the same provider-neutral contract using Unix PTY semantics.
- [ ] Verify Linux paths, signals, resize and UTF-8 independently from Windows `node_modules`.
- [ ] Keep WSL2 server/CLI/database paths native to the Linux checkout.

Verification: fake TUI and Mock interactive sessions pass in an isolated WSL2 checkout.

Commit boundary: Unix runtime and WSL2 smoke documentation.

### Phase 3 — interactive Claude wrapper MVP

#### Step 3.1 — add the interactive CLI command

- [ ] Add `agent-scope claude` with transparent argument and environment forwarding.
- [ ] Resolve the observed workspace from the caller's current directory.
- [ ] Use the same configured database as the running Dashboard.
- [ ] Fall back with an actionable error when a PTY driver or Claude executable is unavailable.
- [ ] Keep `agent-scope run claude -- -p ...` unchanged.

Verification: fake Claude CLI sees identical cwd, environment allow-list, arguments and terminal
dimensions.

Commit boundary: CLI surface and fake-provider integration.

#### Step 3.2 — preserve the native interaction experience

- [ ] Forward keystrokes and output without AgentScope prompts appearing inside Claude's UI.
- [ ] Forward resize events and restore local terminal state after normal or abnormal exit.
- [ ] Preserve exit codes and classify wrapper/provider/terminal failures separately.
- [ ] Ensure AgentScope diagnostics go to a separate safe channel or log.

Verification: ANSI snapshot/fake TUI tests and terminal restoration tests.

Commit boundary: interactive stream and lifecycle behavior.

#### First user checkpoint

After Steps 3.1–3.2 pass automatically, request one manual Windows VS Code Terminal smoke:

1. Start AgentScope and open the Dashboard.
2. Run `agent-scope claude` in a trusted disposable project.
3. Use ordinary Claude input, multiline paste, one approval and one Ctrl+C.
4. Confirm that the native UI remains usable and no orphan process remains.

Do not continue to semantic turn detection if the wrapper degrades normal Claude usage.

### Phase 4 — multi-turn task detection

#### Step 4.1 — implement the turn coordinator

- [ ] Detect when the terminal is ready for user input, when a submission begins work and when
      Claude returns to an idle/waiting state.
- [ ] Combine input boundaries with stable hook signals when present.
- [ ] Avoid treating approval keystrokes, slash-command navigation or multiline editing as new
      tasks.
- [ ] Assign a monotonic turn sequence and stable id.

Verification: recorded fake terminal transcripts cover single-line, multiline, approval, cancel,
retry and rapid consecutive turns.

Commit boundary: coordinator and deterministic tests.

#### Step 4.2 — capture useful local task identity

- [ ] Store the submitted task text locally and generate a compact Dashboard title.
- [ ] Redact obvious secret formats and never promote environment values into the title.
- [ ] Provide a configuration switch to store title only or disable prompt persistence.
- [ ] Do not persist raw hidden reasoning or the complete terminal transcript by default.

Verification: credential-like fixtures are redacted; Unicode and multiline prompts round-trip.

Commit boundary: local prompt/title policy and tests.

#### Step 4.3 — classify waiting, blocked and terminal outcomes

- [ ] Distinguish Claude working, tool running, waiting for approval, waiting for user, blocked,
      completed, failed and interrupted.
- [ ] Treat individual tool errors as evidence; determine the turn outcome from final provider,
      verification and recovery signals instead of one error bit alone.
- [ ] Define timeout/staleness behavior without inventing completion.

Verification: state-machine fixtures cover recovery after a failed tool and a successful final
answer.

Commit boundary: turn lifecycle semantics and regression tests.

### Phase 5 — observer correlation per turn

#### Step 5.1 — scope existing observers to the active turn

- [ ] Attach process, filesystem and Git evidence to the active turn while retaining session-level
      provenance.
- [ ] Snapshot the workspace at turn start/end and calculate paths/statistics without reading
      unrelated files.
- [ ] Prevent delayed debounce events from leaking into the next turn.
- [ ] Deduplicate native/hook/observer evidence through the fusion ledger.

Verification: two rapid turns modifying different files remain correctly separated.

Commit boundary: turn-aware observer runtime.

#### Step 5.2 — correlate verification and Git results

- [ ] Recognize known tests, build, typecheck and lint commands.
- [ ] Associate their start/result/exit code with the correct turn.
- [ ] Link a commit created during a turn using hash, subject and changed-file summary.
- [ ] Keep a provider `completed` result distinct from objective verification status.

Verification: success, failed test, retry-to-pass and commit scenarios are deterministic.

Commit boundary: verification/Git correlation and tests.

### Phase 6 — optional Claude hook enhancement

#### Step 6.1 — build a capability-gated hook adapter

- [ ] Consume only documented or experimentally stable hook fields.
- [ ] Correlate provider session, turn, tool start/finish, approval and stop signals.
- [ ] Validate, redact and normalize hook records before persistence.
- [ ] Disable the hook path automatically when the installed Claude version is incompatible.

Verification: hook-enabled and observer-only modes produce compatible turn projections.

Commit boundary: hook adapter and redacted fixtures.

#### Step 6.2 — keep Kimi/harness compatibility explicit

- [ ] Repeat hook/TTY tests with the configured compatible endpoint and model.
- [ ] Document fields or behaviors that differ from official-account examples.
- [ ] Ensure provider rate-limit/error responses do not damage the terminal session or database.

Verification: a rate-limit retry, tool failure and normal multi-turn session remain recoverable.

Commit boundary: compatibility tests and findings.

### Phase 7 — server, realtime and recovery

#### Step 7.1 — add turn APIs and WebSocket notifications

- [ ] Add paginated session-turn and turn-event/evidence endpoints.
- [ ] Publish `turn.created`, `turn.updated` and `turn.finished` notifications.
- [ ] Preserve HTTP cursor catch-up after Dashboard disconnect/reconnect.
- [ ] Poll external interactive CLI writers without duplicate broadcasts.

Verification: cross-process server/CLI tests cover two turns and reconnect between them.

Commit boundary: server API, live protocol and tests.

#### Step 7.2 — recover interrupted interactive sessions

- [ ] Extend `agent-scope recover` to distinguish stale terminal sessions and stale active turns.
- [ ] Mark only genuinely stale records; do not interrupt a live PTY owned by another process.
- [ ] Record a recovery reason and retain the last safe evidence.
- [ ] Handle server restart independently from the interactive CLI lifecycle.

Verification: abrupt wrapper kill, Dashboard restart and machine-restart simulations converge to a
consistent state.

Commit boundary: recovery behavior and fault-injection tests.

### Phase 8 — multi-turn Dashboard experience

#### Step 8.1 — add session and turn navigation

- [ ] Show one interactive Claude session with an ordered turn list.
- [ ] Highlight the active turn and display its title, status, duration and current activity.
- [ ] Preserve legacy V0 single-task session rendering.
- [ ] Add clear capability labels when hooks or verification signals are unavailable.

Verification: component/data-flow tests cover legacy, interactive and mixed session lists.

Commit boundary: session/turn UI skeleton.

#### Step 8.2 — add per-turn progress and evidence views

- [ ] Show Progress, ETA, files, commands, tests, Git evidence and timeline for the selected turn.
- [ ] Explain confidence and reasons instead of presenting false precision.
- [ ] Show waiting-for-user and approval-required states prominently.
- [ ] Prevent duplicate events after reconnect or pagination.

Verification: two live turns update without losing selection or duplicating timeline entries.

Commit boundary: detailed turn view and UI tests.

#### Step 8.3 — add search, filters and notifications

- [ ] Search by local turn title, workspace, status, file and Git commit.
- [ ] Filter active, waiting, blocked, failed and completed turns.
- [ ] Add opt-in desktop notifications for long-task completion and blocked/approval states.
- [ ] Avoid repeated notifications after reconnect/replay.

Verification: notification idempotency and indexed-query tests pass.

Commit boundary: discovery and notification experience.

### Phase 9 — resume, continue and session grouping

#### Step 9.1 — correlate Claude resume identities

- [ ] Persist provider session ids separately from AgentScope execution ids.
- [ ] Associate `--resume`/`--continue` with the existing logical conversation when reliable.
- [ ] Start a new execution record while keeping one conversation group for auditability.
- [ ] Handle missing, changed or ambiguous provider ids conservatively.

Verification: resume success, invalid id and concurrent resume cases do not merge unrelated work.

Commit boundary: conversation grouping and resume tests.

#### Step 9.2 — support multiple simultaneous agents

- [ ] Group Claude/Codex sessions by workspace and optional user-defined project.
- [ ] Keep each terminal and turn timeline isolated under concurrent writes.
- [ ] Add compact overview counts and blocked/attention indicators.

Verification: at least four concurrent interactive/mock sessions remain correctly separated.

Commit boundary: grouping and concurrency UI/API tests.

### Phase 10 — performance and reliability hardening

#### Step 10.1 — terminal and event-path performance

- [ ] Measure PTY input/output latency, CPU, RSS and buffer growth.
- [ ] Measure event-to-WebSocket and event-to-browser-paint latency for interactive turns.
- [ ] Stress ANSI output, large tool output, resize storms and slow Dashboard clients.
- [ ] Set evidence-backed limits and diagnostics rather than silent unbounded queues.

Verification: publish P50/P95 measurements and capacity boundaries for the supported platforms.

Commit boundary: benchmark scripts, diagnostics and findings.

#### Step 10.2 — long-duration and fault testing

- [ ] Run multi-hour fake and real-provider sessions with many turns.
- [ ] Inject PTY child crash, hook failure, database busy, server restart, WebSocket disconnect and
      outer-terminal closure.
- [ ] Verify no orphan process, lost completed turn or duplicate timeline event.
- [ ] Verify database backup/restore and migration from a real V0 copy.

Verification: automated fault matrix plus bounded manual provider smoke.

Commit boundary: fault tests and known-issue updates.

#### Step 10.3 — security and local data controls

- [ ] Re-run dependency, path-boundary, secret and shell-injection audits after the native driver
      and prompt persistence changes.
- [ ] Add prompt retention controls and a local delete/export flow.
- [ ] Keep raw transcript persistence disabled unless a later explicit opt-in feature is designed.
- [ ] Document exactly what the PTY wrapper, hooks and observers can see.

Verification: secret fixtures stay redacted and deleting a turn removes its local prompt data
without corrupting the session timeline.

Commit boundary: data controls, privacy documentation and audit evidence.

### Phase 11 — V1 release acceptance

#### Step 11.1 — automated release gates

- [ ] Lint, typecheck, unit, integration, migration, fixture and build checks pass.
- [ ] V0 structured Claude/Codex workflows remain green.
- [ ] Windows ConPTY and WSL2 PTY fake/integration suites pass.
- [ ] Cross-process turn broadcasts, pagination and restart recovery pass.

#### Step 11.2 — manual experience acceptance

- [ ] Windows VS Code PowerShell: at least five normal Claude turns in one session.
- [ ] Multiline prompt, approval, file edit, failed-then-recovered command and test run.
- [ ] Ctrl+C current action, normal session exit and abrupt terminal close.
- [ ] WSL2 repeat of the supported interactive flow.
- [ ] Dashboard accurately separates turns and survives refresh/reconnect.
- [ ] Resume/continue behavior matches its documented support level.

#### Step 11.3 — release documentation

- [ ] Update README, configuration, troubleshooting, adapter guide and known issues.
- [ ] Publish a V1 acceptance matrix with evidence for every supported claim.
- [ ] Record unsupported terminal hosts/provider versions as experimental.
- [ ] Create the final local release-prep commit; push/tag only after explicit user approval.

## 7. Delivery sequence and dependencies

```text
Phase 0 driver/hook spike
    ↓
Phase 1 turn protocol/storage
    ↓
Phase 2 PTY runtime
    ↓
Phase 3 usable interactive wrapper ── first user experience checkpoint
    ↓
Phase 4 turn detection
    ↓
Phase 5 observer correlation
    ↓
Phase 6 optional hook enrichment
    ↓
Phase 7 server/recovery
    ↓
Phase 8 Dashboard
    ↓
Phase 9 resume/groups
    ↓
Phase 10 hardening
    ↓
Phase 11 V1 acceptance
```

The first usable milestone is Phase 3: native Claude remains pleasant to use through AgentScope.
The first product-complete milestone is Phase 8: Dashboard understands and displays individual
turns. Resume/grouping and advanced metrics follow only after those two milestones are stable.

## 8. Definition of done for each step

Every completed step must include:

1. Implementation or documentation committed locally as one coherent change.
2. Targeted tests plus proportional typecheck/lint/integration verification.
3. No secrets, prompts or raw provider internals added to tracked fixtures.
4. Backward compatibility or an explicit migration note.
5. Failure and cleanup behavior, not only the happy path.
6. Updates to this roadmap and relevant findings/known-issues documents.

## 9. Expected user checkpoints

User action should be requested only where real terminal feel or provider behavior cannot be
faithfully automated:

1. After Phase 3: native Windows Claude interaction, approval, resize and Ctrl+C feel.
2. After Phase 4/6: whether turn boundaries and waiting/blocked labels match real usage.
3. After Phase 8: Dashboard usability during a real multi-turn coding session.
4. During Phase 11: final Windows and WSL2 release acceptance.

All other implementation, fixtures, automated tests, migrations, diagnostics and local commits can
proceed without per-step user approval unless a dependency install or external credential action
requires it.
