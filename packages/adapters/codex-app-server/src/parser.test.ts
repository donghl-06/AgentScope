import { describe, expect, it } from 'vitest';

import { CodexAppServerStreamDecoder, parseCodexAppServerLine } from './parser.js';

const context = { sessionId: 'session-1', timestamp: 1_700_000_000_000 };

describe('Codex app-server event parser', () => {
  it('maps turn, command, file, plan, usage, and completion notifications', () => {
    const decoder = new CodexAppServerStreamDecoder({
      ...context,
      classifyCommand: (command) => (command.startsWith('pnpm test') ? 'test' : 'command'),
    });
    const lines = [
      {
        method: 'turn/started',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'inProgress' },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          startedAtMs: 1_700_000_000_100,
          item: {
            id: 'command-1',
            type: 'commandExecution',
            command: 'pnpm test -- secret-value-is-not-stored',
            status: 'inProgress',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: 1_700_000_000_200,
          item: { id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0 },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: 1_700_000_000_300,
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/example.ts', kind: 'update', diff: '<redacted>' }],
          },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'plan-1', type: 'plan', title: 'Implement feature', status: 'inProgress' },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'plan-1', type: 'plan', title: 'Implement feature', status: 'completed' },
        },
      },
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 2,
              reasoningOutputTokens: 3,
              totalTokens: 15,
            },
          },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    ].flatMap((message) => decoder.push(`${JSON.stringify(message)}\n`));
    const events = lines.flatMap((result) => result.events);

    expect(events.map((event) => event.type)).toEqual([
      'provider_event',
      'turn_started',
      'provider_event',
      'tool_call_started',
      'command_started',
      'provider_event',
      'tool_call_finished',
      'command_finished',
      'provider_event',
      'file_write',
      'provider_event',
      'milestone_started',
      'provider_event',
      'milestone_completed',
      'provider_event',
      'usage_updated',
      'provider_event',
      'turn_finished',
    ]);
    expect(events.find((event) => event.type === 'command_started')?.payload).toEqual({
      commandKind: 'test',
      commandName: 'test',
    });
    expect(events.find((event) => event.type === 'file_write')?.payload).toEqual({
      path: 'src/example.ts',
    });
    expect(events.find((event) => event.type === 'usage_updated')?.payload).toEqual({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        reasoningTokens: 3,
        totalTokens: 15,
      },
    });
    expect(JSON.stringify(events)).not.toContain('secret-value-is-not-stored');
  });

  it('projects approval and user-input waiting without inventing a turn id', () => {
    const approval = parseCodexAppServerLine(
      JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        },
      }),
      context,
    );
    expect(approval.events.map((event) => event.type)).toEqual(['provider_event', 'blocked']);

    const waiting = parseCodexAppServerLine(
      JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        },
      }),
      context,
    );
    expect(waiting.events.find((event) => event.type === 'turn_updated')?.payload).toEqual({
      turnId: 'turn-1',
      status: 'waiting',
    });
  });

  it('accepts split JSON lines and marks malformed input conservatively', () => {
    const decoder = new CodexAppServerStreamDecoder(context);
    expect(decoder.push('{"method":"thread/started"')).toEqual([]);
    expect(decoder.push(',"params":{}}\n')).toHaveLength(1);
    expect(decoder.flush()).toEqual([]);
    expect(parseCodexAppServerLine('not-json', context)).toMatchObject({
      events: [],
      ignored: false,
      malformed: true,
    });
  });
});
