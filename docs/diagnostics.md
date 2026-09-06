# Diagnostics endpoint

AgentScope exposes a local, read-only diagnostics snapshot at:

```text
GET /api/diagnostics
```

The endpoint is loopback-scoped with the rest of the V0 server and contains no
provider prompt, raw output, token, credential, or workspace file contents.

Example shape:

```json
{
  "protocolVersion": "0.1",
  "startedAt": 1780000000000,
  "uptimeMs": 12345,
  "process": {
    "pid": 1234,
    "nodeVersion": "v24.14.1",
    "platform": "win32-x64"
  },
  "websocket": {
    "clientCount": 1,
    "notificationsPublished": 12,
    "notificationsDelivered": 12,
    "droppedNotifications": 0,
    "slowClientDisconnects": 0,
    "sendFailures": 0,
    "invalidMessages": 0,
    "unsupportedMessages": 0
  },
  "storage": {
    "eventAppendAttempts": 10,
    "eventAppendSuccesses": 10,
    "duplicateEventErrors": 0,
    "busyErrors": 0,
    "eventWriteLatencyMs": {
      "count": 10,
      "total": 4.2,
      "max": 1.1
    }
  }
}
```

Interpretation:

- `x-request-id` is returned on every HTTP response and is safe to use when
  correlating local diagnostics. It is not a provider session id.
- `notificationsPublished` counts notifications emitted by the server; the
  delivered count is per matching client, so it can be greater than published
  when multiple Dashboard clients are connected.
- `sendFailures` counts sockets that failed during a send and were removed.
- `droppedNotifications` and `slowClientDisconnects` count notifications not
  written to a client whose WebSocket buffered amount exceeded the bounded
  threshold. The client is closed so Dashboard reconnect/cursor catch-up can
  recover without allowing an unbounded server-side queue.
- `invalidMessages` and `unsupportedMessages` count malformed WebSocket client
  messages; they do not include provider payloads.
- `eventAppendAttempts` and `eventAppendSuccesses` cover normalized event writes.
  `duplicateEventErrors` and `busyErrors` expose storage contention or duplicate
  ingestion without exposing SQL details.
- `eventWriteLatencyMs` is an aggregate count/total/max for the current server
  lifetime. It is a write-path measurement, not a Dashboard paint-latency SLO.

The snapshot resets when the server restarts. It is intentionally a V0
diagnostic surface rather than a long-term metrics database.
