import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { parseClaudeStreamLine } from './parser.js';

const context = { sessionId: 'session-1', timestamp: 1_700_000_000_000 };

describe('Claude Code stream parser', () => {
  it('maps the redacted success stream without retaining provider text', async () => {
    const lines = (await readFile('tests/fixtures/raw/claude-code/success.stream.jsonl', 'utf8'))
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseClaudeStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'agent_message',
      'session_finished',
    ]);
    expect(events[0]?.payload).toEqual({ providerSessionId: '<provider-session-id>' });
    expect(events[1]?.payload).toEqual({ summary: 'assistant message' });
    expect(events[2]?.payload).toEqual({ reason: 'completed', providerOutcome: 'success' });
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
      'tool_call_started',
      'tool_call_finished',
      'session_finished',
    ]);
    expect(events[1]?.payload).toMatchObject({ toolName: 'Bash' });
    expect(events[1]?.payload).not.toHaveProperty('command');
    expect(events[2]?.payload).toEqual({ toolName: 'unknown', success: false });
  });

  it('marks malformed or unsupported lines without throwing', () => {
    expect(parseClaudeStreamLine('not-json', context)).toMatchObject({
      events: [],
      ignored: false,
      malformed: true,
    });
    expect(parseClaudeStreamLine('{"type":"unknown"}', context)).toEqual({
      events: [],
      ignored: true,
    });
  });
});
