import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { ClaudeStreamDecoder, parseClaudeStreamLine } from './parser.js';

const context = { sessionId: 'session-1', timestamp: 1_700_000_000_000 };

describe('Claude Code stream parser', () => {
  it('maps the redacted success stream without retaining provider text', async () => {
    const lines = (await readFile('tests/fixtures/raw/claude-code/success.stream.jsonl', 'utf8'))
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseClaudeStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'provider_info',
      'provider_event',
      'agent_message',
      'provider_event',
      'usage_updated',
      'provider_event',
      'session_finished',
    ]);
    expect(events.find((event) => event.type === 'session_started')?.payload).toEqual({
      providerSessionId: '<provider-session-id>',
    });
    expect(events.find((event) => event.type === 'provider_info')?.payload).toMatchObject({
      providerSessionId: '<provider-session-id>',
      model: '<configured-model>',
      cliVersion: '2.1.259',
    });
    expect(events.find((event) => event.type === 'agent_message')?.payload).toEqual({
      summary: 'assistant message',
    });
    expect(events.find((event) => event.type === 'usage_updated')?.payload).toMatchObject({
      usage: { durationMs: 3192 },
    });
    expect(events.find((event) => event.type === 'session_finished')?.payload).toEqual({
      reason: 'completed',
      providerOutcome: 'success',
    });
  });

  it('maps tool calls and failures while excluding command contents', async () => {
    const lines = (
      await readFile('tests/fixtures/raw/claude-code/tool-failure.stream.jsonl', 'utf8')
    )
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseClaudeStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'provider_info',
      'provider_event',
      'tool_call_started',
      'provider_event',
      'tool_call_finished',
      'provider_event',
      'usage_updated',
      'provider_event',
      'session_finished',
    ]);
    expect(events.find((event) => event.type === 'tool_call_started')?.payload).toMatchObject({
      toolName: 'Bash',
    });
    expect(events.find((event) => event.type === 'tool_call_started')?.payload).not.toHaveProperty(
      'command',
    );
    expect(events.find((event) => event.type === 'tool_call_finished')?.payload).toMatchObject({
      toolName: 'unknown',
      success: false,
      errorCode: 'provider_tool_error',
    });
  });

  it('marks malformed or unsupported lines without throwing', () => {
    expect(parseClaudeStreamLine('not-json', context)).toMatchObject({
      events: [],
      ignored: false,
      malformed: true,
    });
    expect(parseClaudeStreamLine('{"type":"unknown"}', context)).toMatchObject({
      ignored: false,
      events: [{ type: 'provider_event', payload: { providerEventType: 'unknown' } }],
    });
  });

  it('reassembles split JSONL chunks and accepts CRLF input', () => {
    const decoder = new ClaudeStreamDecoder(context);
    const first = decoder.push('{"type":"system","subtype":"in');
    expect(first).toEqual([]);
    const second = decoder.push('it","session_id":"provider-1"}\r\n');
    expect(second).toHaveLength(1);
    expect(second[0]?.events[0]?.type).toBe('session_started');
    expect(second[0]?.events[0]?.payload).toEqual({ providerSessionId: 'provider-1' });
    expect(decoder.push('{"type":"result"}')).toEqual([]);
    expect(decoder.flush()[0]?.events.at(-1)?.type).toBe('session_finished');
  });
});
