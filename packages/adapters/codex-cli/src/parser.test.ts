import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CodexStreamDecoder, parseCodexStreamLine } from './parser.js';

const context = { sessionId: 'session-1', timestamp: 1_700_000_000_000 };

describe('Codex CLI stream parser', () => {
  it('maps the redacted success stream, usage, and native event envelopes', async () => {
    const lines = (await readFile('tests/fixtures/raw/codex-cli/success.exec.jsonl', 'utf8'))
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseCodexStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'provider_event',
      'planning',
      'provider_event',
      'agent_message',
      'provider_event',
      'usage_updated',
      'session_finished',
      'provider_event',
    ]);
    expect(events[0]?.payload).toEqual({ providerSessionId: '<provider-thread-id>' });
    expect(events.find((event) => event.type === 'usage_updated')?.payload).toEqual({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
    });
    expect(events.find((event) => event.type === 'agent_message')?.payload).toEqual({
      summary: 'agent message',
    });
    expect(events.find((event) => event.type === 'session_finished')?.payload).toEqual({
      reason: 'completed',
    });
  });

  it('maps command execution start and failure without retaining command text', async () => {
    const lines = (await readFile('tests/fixtures/raw/codex-cli/tool-failure.exec.jsonl', 'utf8'))
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseCodexStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'provider_event',
      'planning',
      'provider_event',
      'tool_call_started',
      'command_started',
      'provider_event',
      'tool_call_finished',
      'command_finished',
      'provider_event',
      'tool_call_started',
      'command_started',
      'provider_event',
      'tool_call_finished',
      'command_finished',
      'provider_event',
      'usage_updated',
      'session_finished',
      'provider_event',
    ]);
    expect(events[4]?.payload).toEqual({ toolName: 'command_execution', toolCallId: '<item-id>' });
    expect(events[5]?.payload).toEqual({
      commandKind: 'command',
      commandName: 'command execution',
    });
    expect(events[13]?.payload).toEqual({
      toolName: 'command_execution',
      toolCallId: '<item-id>',
      success: false,
      errorCode: 'provider_tool_error',
    });
    expect(events[14]?.payload).toEqual({ commandKind: 'command', exitCode: 1 });
  });

  it('accepts split JSONL chunks and keeps interrupted streams non-terminal', async () => {
    const decoder = new CodexStreamDecoder(context);
    expect(decoder.push('{"type":"thread.started","thread_id":"provider-1"}\r\n')).toHaveLength(1);
    expect(decoder.push('{"type":"item.started","item":{"type":"command_execution"}}')).toEqual([]);
    expect(decoder.flush()[0]?.events.map((event) => event.type)).toEqual([
      'tool_call_started',
      'command_started',
      'provider_event',
    ]);

    const interrupted = (
      await readFile('tests/fixtures/raw/codex-cli/interrupted.exec.jsonl', 'utf8')
    )
      .trim()
      .split('\n')
      .flatMap((line) => parseCodexStreamLine(line, context).events);
    expect(interrupted.map((event) => event.type)).toEqual([
      'session_started',
      'provider_event',
      'planning',
      'provider_event',
      'agent_message',
      'provider_event',
      'tool_call_started',
      'command_started',
      'provider_event',
    ]);
  });

  it('marks malformed and unsupported records without throwing', () => {
    expect(parseCodexStreamLine('not-json', context)).toMatchObject({
      events: [],
      ignored: false,
      malformed: true,
    });
    expect(parseCodexStreamLine('{"type":"unknown"}', context)).toMatchObject({
      ignored: false,
      events: [{ type: 'provider_event', payload: { providerEventType: 'unknown' } }],
    });
  });
});
