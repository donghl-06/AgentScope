# AgentScope Orchestrator V0 --- Engineering Specification & Implementation Plan

> Audience: Codex / coding agent implementing the next phase of
> AgentScope.
>
> This document is the primary implementation brief. Inspect the
> existing repository before changing architecture. Reuse existing
> AgentScope abstractions and tests wherever possible. Do not rewrite
> working Monitor V0 functionality without a concrete need.

## 1. Mission

AgentScope Monitor V0 is already substantially functional. It can
observe real Claude Code / Codex CLI sessions and expose session
lifecycle, timeline, progress / ETA, Git / file / process / test
evidence through the existing server and Dashboard.

The next phase is **AgentScope Orchestrator V0**.

The product requirement is:

> A user submits one relatively large coding Goal. AgentScope
> autonomously plans the work, executes one task at a time with a single
> coding-agent Worker, independently verifies each task, repairs
> failures, dynamically plans the next task from the latest repository
> state, and continues until the original Goal is verified complete or
> human intervention is required.

The user should no longer need to repeatedly type "continue".

V0 must also expose a minimal UI so the user can submit a Goal and
observe the same execution from the existing AgentScope Dashboard
surface.

------------------------------------------------------------------------

# 2. Non-negotiable design principles

1.  **Single Worker first.** Do not implement multi-worker parallelism
    in V0.
2.  **Evidence before claims.** A Worker saying "done" never marks a
    Task completed.
3.  **Planner, Worker, and Verifier are logically isolated roles.**
4.  **High-level roadmap + rolling planning.** Do not freeze the entire
    detailed plan at startup.
5.  **Prefer continuation over replanning.** Replan only when new
    evidence justifies it.
6.  **UI and CLI must share the same Orchestrator Core.**
7.  **Frontend must never spawn Claude/Codex directly.**
8.  **Reuse AgentScope Observability.** Worker attempts should map to
    existing AgentScope sessions.
9.  **Persist state.** Core Goal / Task / Attempt / Verification state
    must not live only in memory.
10. **Bound autonomy.** Retry limits, pause/abort, and `NEEDS_HUMAN` are
    required.
11. **No Vector DB / Knowledge Graph in V0.** Structured state + code
    search is sufficient.
12. Preserve existing Monitor V0 behavior and regression coverage.

------------------------------------------------------------------------

# 3. V0 scope

Implement:

-   Single workspace per Goal.
-   Single active Worker per Goal.
-   Serial Task execution.
-   Provider abstraction compatible with existing Claude / Codex
    adapters; one primary provider per Goal.
-   Goal persistence and state machine.
-   Bootstrap project analysis.
-   Initial high-level roadmap.
-   Rolling Planner.
-   Project State.
-   Execution Memory.
-   Working Set.
-   Structured Task Contract.
-   Worker execution.
-   Structured Worker Result.
-   Evidence Collector.
-   Deterministic verification.
-   Acceptance-criterion verification.
-   Repair / retry.
-   Final Goal-level verification.
-   Human intervention states.
-   Crash-safe persistence sufficient to inspect and resume safely.
-   Minimal unified Dashboard UI.
-   HTTP/WebSocket integration using existing AgentScope server
    patterns.
-   Real-task acceptance tests.

Explicit V0 non-goals:

-   Parallel Workers.
-   DAG scheduling.
-   Git worktrees.
-   Automatic merges.
-   Worker-to-worker messaging.
-   Intelligent provider routing.
-   Cross-machine execution.
-   Team collaboration.
-   Full interactive TTY.
-   Full conversational mid-run requirement editing.
-   Vector DB / embeddings as a required dependency.
-   Autonomous unbounded retries.

Do not expand into these unless required to keep interfaces extensible.

------------------------------------------------------------------------

# 4. Target architecture

``` text
CLI ------------------┐
                      │
UI -> AgentScope API -┼-> Orchestrator Service
                      │        │
                      │        ├-> Goal Manager
                      │        ├-> Bootstrap Analyzer
                      │        ├-> Planner
                      │        ├-> State Collector
                      │        ├-> Memory Manager
                      │        ├-> Worker Runtime
                      │        ├-> Evidence Collector
                      │        └-> Verifier
                      │
                      └------------------------------+
                                                     |
                                             AgentScope Session
                                                     |
                                              Claude / Codex
                                                     |
                                        existing Observability
                                                     |
                                      DB / WebSocket / Dashboard
```

The Orchestrator should depend on a Worker Runtime abstraction, not
directly on provider-specific UI behavior.

A Worker attempt should be linkable to the AgentScope session created
for that provider execution.

------------------------------------------------------------------------

# 5. Core domain model

Exact names may adapt to repository conventions, but preserve these
concepts.

## 5.1 Goal

Suggested shape:

``` ts
interface Goal {
  id: string;
  workspace: string;
  prompt: string;
  provider: string;
  status: GoalStatus;
  constraints: Constraint[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

Suggested states:

``` text
CREATED
PLANNING
RUNNING
VERIFYING
PAUSED
NEEDS_HUMAN
COMPLETED
FAILED
ABORTED
```

State transitions must be explicit and testable.

## 5.2 Task

``` ts
interface TaskContract {
  id: string;
  goalId: string;
  title: string;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
  verification: VerificationSpec[];
  constraints: string[];
  maxAttempts: number;
  status: TaskStatus;
  sequence?: number;
  tentative?: boolean;
}
```

Suggested Task states:

``` text
PENDING
RUNNING
VERIFYING
REPAIRING
COMPLETED
FAILED
SKIPPED
NEEDS_HUMAN
```

## 5.3 Task Attempt

Each Worker execution is an Attempt.

``` ts
interface TaskAttempt {
  id: string;
  taskId: string;
  attemptNumber: number;
  provider: string;
  sessionId?: string;
  status: AttemptStatus;
  workerResult?: WorkerResult;
}
```

## 5.4 Worker Result

Do not treat Worker output as authoritative.

``` ts
interface WorkerResult {
  claimedStatus: "completed" | "blocked" | "failed";
  summary: string;
  changedFiles?: string[];
  reportedVerification?: unknown;
}
```

## 5.5 Verification Result

``` ts
interface VerificationResult {
  status: "PASS" | "FAIL" | "UNCERTAIN";
  criteria: CriterionResult[];
  deterministicChecks: CheckResult[];
  evidence: EvidenceRef[];
  reason?: string;
}
```

------------------------------------------------------------------------

# 6. Persistence

Extend the existing storage layer instead of creating an unrelated
second persistence mechanism.

Required conceptual tables/entities:

``` text
goals
tasks
task_attempts
verification_runs
orchestrator_events
```

Relationship:

``` text
Goal
 ├── Task
 │    ├── Attempt -> AgentScope Session
 │    └── Attempt -> AgentScope Session
 └── Task
```

Keep three conceptual information layers separate:

### Raw History

Existing AgentScope events, session metadata, tool/test/file/process
evidence.

Used for: - Dashboard; - debugging; - audit; - recovery evidence.

### Structured State

Goal, Task, Attempt, Verification and state transitions.

Used by: - Orchestrator runtime.

### Semantic Memory

Planner-facing compressed decisions and outcomes.

Used by: - Rolling Planner.

Do not feed full raw history to the Planner by default.

------------------------------------------------------------------------

# 7. Bootstrap Analysis

At Goal start, build an initial project context.

Inspect only what is needed to establish:

-   workspace validity;
-   repository / Git status;
-   technology stack;
-   package manager;
-   high-level directory structure;
-   relevant manifests / README;
-   available test / build / typecheck commands where discoverable;
-   code relevant to the Goal.

Use code search / repository inspection to identify the initial Working
Set.

Do not blindly load the whole repository into an LLM context.

Bootstrap output should feed:

-   `ProjectState`;
-   initial `WorkingSet`;
-   initial `ExecutionMemory`;
-   Initial Planner.

------------------------------------------------------------------------

# 8. Project State, Execution Memory, Working Set

## 8.1 Project State

Machine-grounded current facts.

Suggested fields:

``` ts
interface ProjectState {
  workspace: string;
  stack?: string[];
  git: GitState;
  verification: VerificationState;
  relevantModules: string[];
  recentChanges: string[];
}
```

Prefer deterministic collection from Git, filesystem, manifests, tests
and existing AgentScope evidence.

## 8.2 Execution Memory

Planner-facing semantic memory.

``` ts
interface ExecutionMemory {
  goalSummary: string;
  decisions: Decision[];
  completedTasks: TaskMemory[];
  knownIssues: Issue[];
  openQuestions: Question[];
}
```

Decision stability:

``` text
LOCKED
STABLE
TENTATIVE
```

Rules:

-   User requirements / explicit constraints should generally become
    `LOCKED`.
-   Important established architecture decisions should be `STABLE`.
-   Local implementation choices may be `TENTATIVE`.
-   Rolling Planner must not silently overturn `LOCKED` decisions.
-   Changing a `STABLE` decision requires explicit reason/evidence.

Compress completed Tasks. Store raw detail elsewhere.

## 8.3 Working Set

``` ts
interface WorkingSet {
  files: FileReference[];
  symbols: SymbolReference[];
  tests: FileReference[];
  docs: FileReference[];
}
```

It represents the subset of the repository currently relevant to the
Goal.

After each Attempt / Task:

``` text
collectProjectState()
updateExecutionMemory()
updateWorkingSet()
```

If Planner lacks information, it should request inspection/search rather
than hallucinate.

------------------------------------------------------------------------

# 9. Planner

## 9.1 Initial Planner

Input:

-   original Goal;
-   constraints;
-   Bootstrap Analysis;
-   Project State;
-   Working Set.

Output:

-   high-level roadmap;
-   first locked Task;
-   approximately 2--4 likely/tentative next Tasks.

Do not fully specify dozens of immutable Tasks upfront.

## 9.2 Rolling Planner

Run after a Task is independently verified or when material new evidence
appears.

Input:

``` text
Original Goal
+ Locked / Stable Decisions
+ Current Project State
+ Execution Memory
+ Working Set
+ Last Task Contract
+ Worker Result
+ Verification Result
+ relevant Git/test evidence
```

Allowed outputs should be structured actions such as:

``` text
NEXT_TASK
INSPECT
REPLAN
GOAL_READY_FOR_FINAL_VERIFICATION
NEEDS_HUMAN
```

Planner behavior:

-   default to continuing the roadmap;
-   update tentative future tasks when needed;
-   insert/delete/reorder future tasks only with reason;
-   never mark a Task completed itself;
-   never mark the Goal completed itself;
-   request inspection if context is insufficient.

------------------------------------------------------------------------

# 10. Task Contract generation

Every executable Task must have explicit acceptance criteria and
verification strategy.

Example:

``` yaml
id: AUTH-003
title: Implement login endpoint
objective: Implement POST /api/auth/login

acceptance_criteria:
  - id: AC-1
    requirement: Valid credentials return HTTP 200
  - id: AC-2
    requirement: Invalid credentials return HTTP 401
  - id: AC-3
    requirement: JWT is returned
  - id: AC-4
    requirement: Existing API behavior is preserved

verification:
  - command: pnpm test auth
  - command: pnpm typecheck

constraints:
  - Do not modify unrelated packages

max_attempts: 3
```

Where possible, Planner should associate each criterion with a
verification strategy.

------------------------------------------------------------------------

# 11. Worker Runtime

Worker Runtime responsibilities:

1.  Convert Task Contract + minimal relevant context into provider
    input.
2.  Launch through the existing AgentScope execution/session path.
3.  Link Attempt ID to AgentScope Session ID.
4.  Observe completion / interruption / failure.
5.  Return structured Worker Result.
6.  Never independently advance the roadmap.

Worker prompt must clearly constrain scope. Include an instruction
equivalent to:

> Complete only the current Task Contract. Do not proceed to later
> planned tasks.

Repair Attempts receive previous failure evidence.

Provider-specific implementation must remain behind an adapter/runtime
interface.

------------------------------------------------------------------------

# 12. Verification architecture

Verification is a first-class subsystem.

## 12.1 Evidence Collector

Collect relevant evidence after each Attempt:

-   Git diff / status;
-   changed files;
-   command exit codes;
-   targeted tests;
-   typecheck;
-   lint;
-   build;
-   runtime behavior where available;
-   AgentScope events;
-   expected file / artifact existence.

## 12.2 Deterministic Verifier

Run deterministic checks before LLM judgment.

Examples:

``` text
test command exit code
build
typecheck
lint
file exists
expected command output
API behavior where testable
```

Hard failures must not be overridden merely because the Worker claims
success.

## 12.3 Contract Verifier

Evaluate each Acceptance Criterion independently.

Return:

``` text
PASS
FAIL
UNCERTAIN
```

with evidence.

LLM verification, if used, should have an isolated context and primarily
consume:

-   Task Contract;
-   relevant diff;
-   deterministic results;
-   selected project context.

Do not simply ask the Worker to grade itself.

## 12.4 Regression Gates

Use tiered verification:

### Fast Gate

Per Task: - targeted tests; - typecheck or similarly cheap checks.

### Periodic Gate

After meaningful milestones: - module / broader tests.

### Final Gate

Before Goal completion: - full relevant test suite; - build where
applicable; - final Goal-level verification.

Avoid running an expensive full suite after every tiny Task unless
repository characteristics require it.

------------------------------------------------------------------------

# 13. Repair loop

On Verification `FAIL`, generate a Repair Task / Repair Attempt with
explicit failure evidence.

Required context:

``` text
parent task
failed criterion/check
failure evidence
current project state
previous changes
repair objective
```

Do not blindly rerun the original prompt.

Default target:

``` text
maxAttempts = 3
```

After the limit, transition to `NEEDS_HUMAN` unless an explicit policy
says otherwise.

No infinite retry loops.

------------------------------------------------------------------------

# 14. Goal-level verification

A Goal is NOT complete because all planned Tasks are marked complete.

Before `COMPLETED`, independently compare:

``` text
Original User Goal
+ Locked Constraints
+ Final Project State
+ Completed Task summaries
+ Git/diff evidence
+ Verification evidence
```

Produce requirement-level results.

Example:

``` yaml
requirements:
  - requirement: Email/password login works
    status: satisfied
    evidence: [...]
  - requirement: Login redirects to dashboard
    status: missing
    evidence: []
```

If a requirement is missing:

``` text
generate Gap Task
-> execute
-> verify
-> run Goal verification again
```

Only mark `Goal = COMPLETED` when final verification passes or
explicitly accepted human review resolves uncertainty.

------------------------------------------------------------------------

# 15. Human intervention

Required controls/states:

-   Pause.
-   Abort.
-   `NEEDS_HUMAN`.

Escalate when appropriate:

-   retry limit reached;
-   requirement materially ambiguous;
-   high-risk action;
-   permission / secret issue;
-   critical `UNCERTAIN`;
-   budget/time policy exceeded;
-   Planner cannot safely continue.

Do not silently choose destructive/high-risk behavior to keep autonomy
running.

------------------------------------------------------------------------

# 16. Minimal V0 UI

Extend the existing Dashboard rather than building a separate unrelated
frontend.

## 16.1 New Goal UI

Required fields:

``` text
Workspace
Goal
Provider
Start
```

Do not build a full chat interface in V0.

## 16.2 Goal Detail UI

Display:

-   Goal status;
-   progress / ETA when available;
-   roadmap;
-   tentative future Tasks;
-   current Task;
-   acceptance criteria;
-   current Worker / provider;
-   Attempt number;
-   verification results;
-   repair state;
-   timeline / AgentScope evidence;
-   `NEEDS_HUMAN` reason.

## 16.3 Controls

V0 minimum:

``` text
Pause
Abort
```

Resume may be implemented if required by the persistence/recovery
design, but avoid turning V0 into a conversational control surface.

## 16.4 API boundary

Required architecture:

``` text
Dashboard / CLI
       ↓
AgentScope Server API
       ↓
Orchestrator Service
       ↓
Worker Runtime
       ↓
Claude / Codex
```

The browser must not execute local providers directly.

Use existing WebSocket/event infrastructure for live updates where
practical.

------------------------------------------------------------------------

# 17. Recovery expectations

V0 should persist enough information that a process/server restart does
not make a Goal silently appear completed or lose its task history.

On startup/recovery:

-   detect Goals/Tasks left in running states;
-   reconcile against Worker/session/process evidence;
-   transition conservatively;
-   never duplicate an active Attempt blindly;
-   if state cannot be safely reconstructed, prefer `NEEDS_HUMAN`.

Full sophisticated distributed recovery is not required.

------------------------------------------------------------------------

# 18. Suggested implementation sequence

Implement incrementally. Keep the repository passing tests after each
phase.

## Phase 0 --- Repository reconnaissance

Before coding:

1.  Inspect monorepo/package structure.
2.  Identify current DB/storage abstractions.
3.  Identify AgentScope session creation/execution path.
4.  Identify Claude/Codex adapter interfaces.
5.  Identify server REST/WebSocket architecture.
6.  Identify Dashboard state/data architecture.
7.  Identify existing state/recovery utilities.
8.  Produce a short implementation map before major changes.

Do not assume paths from this document if the repository differs.

## Phase 1 --- Domain + persistence

Implement/test:

-   Goal model/state machine.
-   Task model/state machine.
-   Task Attempt.
-   Verification Run.
-   Orchestrator Event.
-   DB migrations/repository methods.

Acceptance: - state transitions unit tested; - persistence survives
process restart; - existing Monitor tests remain green.

## Phase 2 --- Project context

Implement/test:

-   Bootstrap Analyzer.
-   Project State Collector.
-   Working Set.
-   Execution Memory.
-   decision stability (`LOCKED/STABLE/TENTATIVE`).

Acceptance: - deterministic project facts collected without LLM where
possible; - completed Task memory can be compressed; - Planner context
can be assembled without full-repo dump.

## Phase 3 --- Planner

Implement:

-   Initial Roadmap planner.
-   structured Planner output.
-   Rolling Planner.
-   inspect request path.
-   tentative future Tasks.

Acceptance: - current Task is explicit; - Planner cannot complete Goal
directly; - locked decisions are preserved; - planner can request more
repository inspection.

## Phase 4 --- Worker Runtime

Integrate one provider first using existing AgentScope execution path.

Acceptance: - Task -\> Attempt -\> AgentScope Session linkage exists; -
Worker scope is limited to current Task; - result is structured; -
interruption/failure is represented correctly.

Once stable, ensure the provider abstraction can support the second
existing provider without redesign.

## Phase 5 --- Evidence + Verifier

Implement:

-   Evidence Collector.
-   deterministic checks.
-   criterion-by-criterion Verification.
-   `PASS/FAIL/UNCERTAIN`.
-   fast regression gate.

Acceptance: - Worker claim cannot override deterministic failure; -
failed criterion includes evidence; - verification is persisted.

## Phase 6 --- Repair loop

Implement:

``` text
FAIL
-> Repair context
-> next Attempt
-> verify
-> bounded retry
-> NEEDS_HUMAN
```

Acceptance: - no infinite loop; - failure evidence is carried forward; -
attempt history remains visible.

## Phase 7 --- Rolling autonomous loop

Wire:

``` text
Goal
-> bootstrap
-> plan
-> task
-> worker
-> verify
-> update state/memory
-> rolling plan
-> next task
```

Acceptance: - a multi-step Goal can advance through several Tasks
without user typing "continue".

## Phase 8 --- Final Goal Verifier

Implement original-requirement reconciliation and Gap Tasks.

Acceptance: - completed Tasks alone cannot complete a Goal; - missing
original requirement creates a Gap Task or human escalation.

## Phase 9 --- Minimal unified UI

Add:

-   New Goal form.
-   Goal detail view.
-   Roadmap.
-   current Task.
-   acceptance criteria.
-   Worker/Attempt.
-   verification.
-   timeline/evidence.
-   Pause/Abort.
-   human-attention state.

Use existing Dashboard design language and event infrastructure.

## Phase 10 --- Recovery + real-task acceptance

Run realistic coding Goals and fix reliability issues.

------------------------------------------------------------------------

# 19. Testing strategy

Tests should include:

### Unit

-   Goal state transitions.
-   Task state transitions.
-   decision lock behavior.
-   planner structured-output validation.
-   retry limits.
-   verification aggregation.
-   final Goal completion rules.

### Integration

-   Goal -\> Task -\> mock Worker -\> Verify -\> next Task.
-   verification failure -\> Repair -\> success.
-   repeated failure -\> `NEEDS_HUMAN`.
-   server restart / persistence reconciliation.
-   WebSocket/UI receives Orchestrator updates.
-   Attempt correctly links to AgentScope Session.

### Real provider smoke

Use safe repository tasks with Claude and/or Codex after
deterministic/mocked tests pass.

Do not make paid/network provider tests mandatory for ordinary unit test
runs.

------------------------------------------------------------------------

# 20. V0 acceptance benchmark

Prepare representative tasks such as:

1.  Add a small API.
2.  Fix a test-covered bug.
3.  Add a React page/component.
4.  Modify a schema.
5.  Refactor a module.
6.  Add a CLI option.
7.  Add logging.
8.  Fix a type error.
9.  Add unit tests.
10. Implement a small cross-frontend/backend feature.

Track:

``` text
Goal completion rate
Task success rate
Average repair attempts
Human intervention rate
False completion rate
Runtime
Token/cost where available
```

**False Completion Rate is a primary reliability metric.**

A V0 success condition is not "the demo looks autonomous". It is:

> The system can reliably execute several sequential coding Tasks from
> one Goal without repeated human "continue" prompts, while refusing to
> claim completion when verification evidence does not support it.

------------------------------------------------------------------------

# 21. V1 roadmap

Do not implement unless V0 is stable.

V1 evolves the UI into a deeper Agent Control Center:

-   persistent Goal history;
-   robust resume/retry/recovery;
-   human instruction input;
-   `Give Instruction` / Continue;
-   editable roadmap;
-   insert/delete Task;
-   richer Execution Memory;
-   stronger risk controls;
-   notifications;
-   better Goal/session navigation;
-   more mature UI/UX.

Maintain the same Orchestrator Core/API boundary.

------------------------------------------------------------------------

# 22. V2 roadmap

V2 introduces multi-agent orchestration:

-   multiple Workers;
-   DAG Scheduler;
-   task dependencies;
-   parallel execution;
-   Claude/Codex/multiple providers;
-   Git worktree isolation;
-   merge/conflict handling;
-   intelligent Router;
-   provider selection using success/cost/speed history;
-   Worker Graph / DAG UI;
-   parallel progress;
-   multi-project;
-   remote monitoring;
-   analytics/cost;
-   team/governance foundations.

Design V0 interfaces so these are possible later, but **do not
prematurely implement V2 abstractions at the cost of V0 simplicity**.

------------------------------------------------------------------------

# 23. Working rules for Codex while implementing this plan

1.  Inspect before editing.
2.  Reuse existing repository conventions.
3.  Make incremental changes.
4.  Add tests with each behavior.
5.  Run relevant tests/typecheck/lint after each meaningful phase.
6.  Preserve existing AgentScope Monitor behavior.
7.  Do not silently broaden scope.
8.  When a design detail is not specified, choose the simplest solution
    compatible with V0 and document the decision.
9.  If an existing implementation conflicts with this plan, prefer
    adapting the plan to the real architecture rather than rewriting
    stable code.
10. Keep provider-specific behavior behind interfaces.
11. Keep state transitions explicit.
12. Treat recovery and verification conservatively.
13. Never use "Worker said done" as completion evidence.
14. Before declaring V0 complete, run the end-to-end acceptance loop on
    real coding tasks.

------------------------------------------------------------------------

# 24. Definition of Done for Orchestrator V0

Orchestrator V0 is complete when all of the following are true:

-   User can create a Goal from the AgentScope UI.
-   Goal is persisted.
-   System bootstraps project context.
-   System generates a high-level roadmap.
-   System creates a structured current Task.
-   A Worker executes the Task through AgentScope.
-   Attempt is linked to a Session.
-   Evidence is collected independently.
-   Acceptance criteria are verified.
-   Failed verification creates bounded Repair Attempts.
-   Verified Tasks automatically advance to rolling planning.
-   Planner can adapt future Tasks from current repository state.
-   Locked user constraints are preserved.
-   System can execute multiple sequential Tasks without manual
    "continue".
-   Final Goal Verification checks the original user requirements.
-   Missing requirements generate Gap Tasks or human escalation.
-   Goal cannot falsely complete solely from Worker claims.
-   UI shows Goal/Roadmap/Task/Worker/Verification/Timeline state.
-   Pause/Abort or equivalent safe controls work.
-   Restart/recovery does not silently corrupt Goal state.
-   Existing Monitor functionality remains operational.
-   Unit/integration tests pass.
-   Representative real-task acceptance has been performed.

After this definition is met, stop expanding V0 and move remaining
enhancements into V1/V2.
