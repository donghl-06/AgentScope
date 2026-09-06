# Process and platform spike findings

Date: 2026-09-05  
Host: Windows native, Node.js v24.14.1, pnpm 11.19.0  
Secondary environment: WSL2 (Linux 5.15.167.4-microsoft-standard-WSL2)

## Findings

| Area | Result | V0 implication |
|---|---|---|
| Direct executable spawn | `spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']})` returned exit code 0 and preserved `ok-测试`. | Use `spawn(executable, args)` with explicit stdio; do not construct a shell command string. |
| `.cmd` resolution | Direct `spawn('pnpm.cmd', ['--version'])` failed with Windows `EINVAL`. Explicit `cmd.exe /d /s /c pnpm.cmd --version` succeeded with code 0. | Resolve `.exe` directly. For `.cmd`, use a narrowly scoped `cmd.exe` wrapper with an argument-safe command line; never enable a general-purpose shell for arbitrary user input. |
| Unicode cwd and args | A child launched with `D:\大学\项目\AgentScope` and `参数-测试` received both values unchanged. | Keep native paths and argument arrays intact; display-path conversion belongs outside the process runner. |
| Process-tree cleanup | A long-running `cmd.exe` child was terminated with `taskkill /PID <pid> /T /F`; the child closed with code 1 and no signal. | Cleanup must be idempotent and use tree termination on Windows when a wrapper owns descendants. The resulting exit mapping should preserve an explicit interrupted/terminated reason. |
| Second target smoke | WSL2 executed `uname -a` and a shell command successfully. | A Linux-specific process test can be added to CI/manual smoke; no Windows path conversion should leak into the Linux runner. |

## Path boundary

- `nativePath`: the exact path passed to the host process API.
- `canonicalPath`: normalized internal identity used for comparison and persistence.
- `displayPath`: user-facing path formatted for the current UI/context.
- Only the platform package may convert between Windows and WSL path forms. Protocol, Core, Storage, and Dashboard consume canonical/display values and never invoke `wslpath` or string replacement themselves.

## Open items

- Real Ctrl+C/ Ctrl+Break delivery to an attached interactive process still requires the Phase 5 wrapper/manual TTY experiment. The current synthetic cleanup result must not be treated as equivalent to console signal forwarding.
- WSL2 interactive Ubuntu exposes Node `22.14.0` and pnpm `10.33.0`; an isolated Linux clone passed the Mock CLI smoke, and the user confirmed real Claude plus same-database Dashboard relay on 2026-09-07. The shared Windows checkout remains separate because native dependencies are platform-specific.
- PTY remains optional for the V0 non-interactive structured path. Interactive passthrough is not declared complete until the Claude/Codex TTY experiments are repeatable.
