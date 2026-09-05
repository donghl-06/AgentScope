import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CodexStreamDecoder, parseCodexStreamLine } from './parser.js';

const context = { sessionId: 'session-1', timestamp: 1_700_000_000_000 };

describe('Codex CLI stream parser', () => {
  it('maps the redacted success stream without retaining provider text or usage', async () => {
    const lines = (await readFile('tests/fixtures/raw/codex-cli/success.exec.jsonl', 'utf8'))
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseCodexStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'planning',
      'agent_message',
      'session_finished',
    ]);
    expect(events[0]?.payload).toEqual({ providerSessionId: '<provider-thread-id>' });
    expect(events[2]?.payload).toEqual({ summary: 'agent message' });
    expect(events[3]?.payload).toEqual({ reason: 'completed' });
    expect(events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ usage: expect.anything() })]),
    );
  });

  it('maps command execution start and failure without retaining command text', async () => {
    const lines = (await readFile('tests/fixtures/raw/codex-cli/tool-failure.exec.jsonl', 'utf8'))
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => parseCodexStreamLine(line, context).events);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'planning',
      'command_started',
      'command_finished',
      'command_started',
      'command_finished',
      'session_finished',
    ]);
    expect(events[2]?.payload).toEqual({
      commandKind: 'command',
      commandName: 'command execution',
    });
    expect(events[5]?.payload).toEqual({ commandKind: 'command', exitCode: 1 });
  });

  it('accepts split JSONL chunks and keeps interrupted streams non-terminal', async () => {
    const decoder = new CodexStreamDecoder(context);
    expect(decoder.push('{"type":"thread.started","thread_id":"provider-1"}\r\n')).toHaveLength(1);
    expect(decoder.push('{"type":"item.started","item":{"type":"command_execution"}}')).toEqual([]);
    expect(decoder.flush()[0]?.events[0]?.type).toBe('command_started');

    const interrupted = (
      await readFile('tests/fixtures/raw/codex-cli/interrupted.exec.jsonl', 'utf8')
    )
      .trim()
      .split('\n')
      .flatMap((line) => parseCodexStreamLine(line, context).events);
    expect(interrupted.at(-1)?.type).toBe('command_started');
  });

  it('marks malformed and unsupported records without throwing', () => {
    expect(parseCodexStreamLine('not-json', context)).toMatchObject({
      events: [],
      ignored: false,
      malformed: true,
    });
    expect(parseCodexStreamLine('{"type":"unknown"}', context)).toEqual({
      events: [],
      ignored: true,
    });
  });
});
