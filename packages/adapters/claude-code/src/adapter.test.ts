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
    expect(session.pid).toBeTypeOf('number');
    const events = [];
    for await (const event of session.events()) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'provider_info',
      'provider_event',
      'tool_call_started',
      'provider_event',
      'provider_event',
      'session_finished',
    ]);
    expect(events.find((event) => event.type === 'session_started')?.payload).toEqual({
      providerSessionId: 'provider-1',
    });
    expect(events.find((event) => event.type === 'tool_call_started')?.payload).toMatchObject({
      toolName: 'Bash',
    });
    expect(events.find((event) => event.type === 'tool_call_started')?.payload).not.toHaveProperty(
      'command',
    );
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'completed' });
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

    const toolFailure = await new ClaudeCodeAdapter({ executable: process.execPath }).start({
      sessionId: 'tool-failed',
      workspacePath,
      args: [
        '-e',
        nodeScript([
          '{"type":"system","subtype":"init"}',
          '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}',
          '{"type":"result","subtype":"success","is_error":false}',
        ]),
      ],
    });
    const toolFailureEvents = [];
    for await (const event of toolFailure.events()) toolFailureEvents.push(event);
    expect(toolFailureEvents.at(-1)?.payload).toMatchObject({ reason: 'failed' });

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

  it('records malformed structured output while preserving a later valid completion', async () => {
    const session = await new ClaudeCodeAdapter({ executable: process.execPath }).start({
      sessionId: 'malformed',
      workspacePath,
      args: [
        '-e',
        nodeScript([
          'this is not JSON',
          '{"type":"system","subtype":"init","session_id":"provider-malformed"}',
          '{"type":"result","subtype":"success","is_error":false}',
        ]),
      ],
    });
    const events = [];
    for await (const event of session.events()) events.push(event);

    expect(events.find((event) => event.type === 'error')?.payload).toMatchObject({
      code: 'invalid_output',
    });
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'completed' });
  });
});
