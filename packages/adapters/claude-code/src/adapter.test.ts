import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentscope/protocol';

import { ClaudeCodeAdapter } from './adapter.js';

const workspacePath = process.cwd();

function nodeScript(lines: readonly string[], exitCode = 0): string {
  return `process.stdout.write(${JSON.stringify(`${lines.join('\n')}\n`)}); process.exit(${exitCode});`;
}

describe('Claude Code adapter lifecycle', () => {
  it('detects an executable without calling a provider API', async () => {
    const result = await new ClaudeCodeAdapter({ executable: process.execPath }).detect({
      workspacePath,
      executablePath: process.execPath,
      environment: 'windows',
    });

    expect(result.available).toBe(true);
    expect(result.version).toContain('v');
  });

  it('preserves structured stdout as safe normalized events and closes on success', async () => {
    const session = await new ClaudeCodeAdapter({ executable: process.execPath }).start({
      sessionId: 'session-1',
      workspacePath,
      args: [
        '-e',
        nodeScript([
          '{"type":"system","subtype":"init","session_id":"provider-1"}',
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"secret"}}]}}',
          '{"type":"result","subtype":"success","is_error":false}',
        ]),
      ],
    });
    const events = [];
    for await (const event of session.events()) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_started',
      'session_finished',
    ]);
    expect(events[0]?.payload).toEqual({ providerSessionId: 'provider-1' });
    expect(events[1]?.payload).toMatchObject({ toolName: 'Bash' });
    expect(events[1]?.payload).not.toHaveProperty('command');
    expect(events[2]?.payload).toMatchObject({ reason: 'completed' });
  });

  it('maps non-zero process exits to failed and stop to interrupted', async () => {
    const failed = await new ClaudeCodeAdapter({ executable: process.execPath }).start({
      sessionId: 'failed',
      workspacePath,
      args: ['-e', nodeScript([], 3)],
    });
    const failedEvents = [];
    for await (const event of failed.events()) failedEvents.push(event);
    expect(failedEvents.at(-1)?.payload).toMatchObject({ reason: 'failed', exitCode: 3 });

    const interrupted = await new ClaudeCodeAdapter({ executable: process.execPath }).start({
      sessionId: 'interrupted',
      workspacePath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
    });
    const interruptedEvents: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of interrupted.events()) interruptedEvents.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await interrupted.stop();
    await collecting;
    expect(interruptedEvents.at(-1)?.payload).toMatchObject({ reason: 'interrupted' });
  });
});
