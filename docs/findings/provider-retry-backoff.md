# Provider retry backoff

AgentScope V1 only waits before a new Attempt when the previous Worker result
contains a normalized, retryable failure (`rate_limit`, `network`, or
`invalid_output`). Authentication, permission, spawn, interruption, and
unknown failures do not receive an automatic delay.

The default policy is deliberately bounded:

- first retry delay: 1 second;
- exponential growth per retry, capped at 30 seconds;
- cumulative Task retry-wait cap: 60 seconds;
- symmetric random jitter: ±20%;
- cancellation checks: at most every 250 ms.

The wait happens at the safe boundary after the failed Attempt has finished and
before the next Attempt is created. A Pause or Abort request, a hard execution
budget, an AbortSignal supplied by an embedding host, or a lease failure can
therefore prevent the next Provider process from starting. A cancelled wait
never creates a replacement Attempt.

Each scheduled wait records an
`attempt.retry_backoff.started` event. Normal completion records
`attempt.retry_backoff.completed`; cancellation records
`attempt.retry_backoff.cancelled`. The started delay is counted when a Goal is
restarted, so an interrupted process cannot reset the cumulative cap. Timers
are in-memory only and are always cleared on completion; a process restart
reconstructs state from the persisted Attempt/event boundary instead of
reusing an old timer.

The policy and clock/waiter are injectable for deterministic tests and for
future host-specific cancellation. Missing or malformed Provider diagnostics
remain redacted; the retry events contain only normalized failure codes and
bounded numeric timing data.
