# AgentScope V0 Privacy and Data Handling

Status: Required baseline

## 1. Principle

AgentScope collects the minimum information needed to explain observable task state. Local-first does not mean “collect everything locally.” Data that is not required for lifecycle, workspace activity, verification, Progress, ETA, or user-requested diagnostics is not collected.

## 2. Data classification

### 2.1 Allowed by default

- AgentScope-generated session and event identifiers.
- Provider/client/adapter name and version.
- Declared adapter capabilities and confidence.
- Process start/end time, PID, exit code, and termination reason for processes started by AgentScope.
- Workspace root identifier and display-safe path required to associate a session.
- Git branch, HEAD identifier, dirty file paths, and aggregate diff statistics within the workspace.
- File create/modify/delete paths and minimal stat metadata within the workspace.
- Recognized command category, start/end, duration, and exit status.
- Test/build/lint/typecheck pass/fail summaries.
- Milestone names explicitly exposed through a supported structured provider interface.
- Derived SessionState, Progress, ETA, reasons, and confidence.
- AgentScope operational diagnostics with secrets redacted.

### 2.2 Disabled by default

- Complete stdout/stderr capture.
- Raw structured provider event storage.
- Full command output.
- File contents or diffs.
- Full agent messages and prompts.
- Token usage or cost details.
- Commit messages and remote repository URLs.

These may only be introduced behind explicit configuration, a documented purpose, bounded retention, and redaction. Enabling one category does not enable the others.

### 2.3 Prohibited in V0

- Private chain-of-thought or hidden reasoning.
- Credentials, API keys, access tokens, cookies, SSH private keys, or authentication headers.
- Complete environment variable dumps.
- Machine-wide process inventories unrelated to AgentScope-wrapped sessions.
- Files outside the resolved workspace.
- Screenshot/OCR/GUI scraping of Codex App or other agents.
- Silent network upload, telemetry, cloud synchronization, or third-party analytics.

## 3. Collection boundaries

### Process boundary

ProcessObserver observes only the process started by AgentScope and the minimum child-process metadata necessary for lifecycle cleanup. It does not enumerate unrelated processes or persist their command lines and environments.

### Workspace boundary

GitObserver and FileObserver operate only below a resolved workspace root. Implementations must:

- reject path traversal outside the root;
- handle symlinks without escaping the root;
- respect `.gitignore`, AgentScope defaults, and user ignore rules;
- exclude `.git`, `node_modules`, build/cache output, and the AgentScope database by default;
- avoid reading file contents when path/stat evidence is sufficient.

### Provider boundary

Adapters normalize only fields required by the unified protocol. Provider-specific records are not copied wholesale into event payloads. Unknown records are ignored or represented by redacted diagnostics.

## 4. Storage policy

- SQLite remains on the local machine in a user-controlled path.
- Raw logs are off by default.
- JSON payloads contain normalized minimal data, not duplicated raw provider records.
- Secrets discovered during parsing are dropped, not merely hidden in the UI.
- Database, WAL/SHM files, raw logs, and local environment files are Git-ignored.
- Schema migrations must preserve the privacy classification of existing fields.

V0 retains normalized session history until the user deletes the local database. Before release, documentation must explain the database location, backup, deletion, and the difference between deleting a session and deleting raw diagnostic files.

## 5. Logging policy

- Logs are structured and level-controlled.
- Session/request correlation IDs are allowed.
- Full prompt, agent message, command output, environment, or raw event serialization is forbidden in ordinary logs.
- Errors include stable codes and redacted context.
- Parser diagnostics may include provider event type, byte count, and location, but not the raw record.
- The wrapped Agent stdout must not be duplicated into the server log.

## 6. Raw diagnostic opt-in

If a later Step implements raw diagnostics, all of the following are required:

1. Explicit user opt-in; default remains off.
2. A path under an AgentScope-controlled diagnostics directory.
3. Visible warning describing sensitive-data risk.
4. Size and retention limits.
5. Redaction before persistence where technically possible.
6. No Git tracking.
7. A documented deletion command or procedure.
8. Tests proving that disabling the option creates no raw artifacts.

Raw storage is a diagnostic capability, not a prerequisite for normal monitoring.

## 7. Network policy

- HTTP/WebSocket binds to loopback by default.
- The server makes no telemetry or analytics requests.
- Adapter-launched provider CLIs retain their own network behavior; AgentScope does not proxy or copy credentials.
- Binding to a non-loopback interface is an explicit advanced configuration and must display a warning before V0 release.

## 8. Fixture policy

Real raw samples must be sanitized before entering `tests/fixtures/raw`.

Review checklist:

- Replace usernames and absolute home/workspace paths.
- Remove prompts, model responses, source code, diffs, and file contents unless synthetic.
- Remove tokens, IDs tied to accounts, remote URLs, and environment values.
- Preserve only the minimal structure needed to test the parser.
- Prefer synthetic equivalents after the real shape has been validated.
- Run a secret scanner and human review before commit.

## 9. User controls required for V0

- Configurable database path.
- Configurable log level.
- Configurable workspace ignore rules.
- Clear visibility of adapter capabilities and inferred/native evidence.
- Documented method to stop AgentScope and remove its local database.

Raw log controls are required only if raw storage is implemented; otherwise the product documents that raw storage is unavailable and disabled.

## 10. Security review gate

Before V0 release, tests or review evidence must demonstrate:

- no shell-string injection path in the general wrapper;
- no observer event outside the workspace;
- no environment/token/prompt values in default DB, logs, or fixtures;
- loopback-only default binding;
- private SSH keys and local database artifacts remain untracked;
- cleanup closes process, watcher, WebSocket, timer, and DB resources.
