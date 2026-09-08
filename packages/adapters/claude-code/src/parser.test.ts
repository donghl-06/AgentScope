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

  it('correlates tool results across decoder chunks without retaining tool input', () => {
    const decoder = new ClaudeStreamDecoder(context);
    const results = [
      ...decoder.push(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"secret"}}]}}\n',
      ),
      ...decoder.push(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","is_error":false}]}}\n',
      ),
    ];
    const finished = results.find((item) => item.events[0]?.type === 'tool_call_finished');
    expect(finished?.events[0]?.payload).toMatchObject({
      toolName: 'Bash',
      toolCallId: 'tool-1',
      success: true,
      durationMs: 0,
    });
    expect(finished?.events[0]?.payload).not.toHaveProperty('command');
  });

  it('normalizes stream event usage and tool boundaries', () => {
    const start = parseClaudeStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 10, output_tokens: 1 } },
        },
      }),
      context,
    );
    const tool = parseClaudeStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-2', name: 'Read' },
        },
      }),
      context,
    );

    expect(start.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'usage_updated',
          payload: { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
        }),
        expect.objectContaining({
          type: 'provider_event',
          payload: { providerEventType: 'stream_event', phase: 'message_start' },
        }),
      ]),
    );
    expect(tool.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call_started',
          payload: expect.objectContaining({ toolName: 'Read' }),
        }),
      ]),
    );
  });

  it('does not double-count a tool announced in assistant and stream frames', () => {
    const decoder = new ClaudeStreamDecoder(context);
    const results = [
      ...decoder.push(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-3","name":"Bash"}]}}\n',
      ),
      ...decoder.push(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-3","name":"Bash"}}}\n',
      ),
    ];
    const starts = results.flatMap((result) =>
      result.events.filter((event) => event.type === 'tool_call_started'),
    );
    expect(starts).toHaveLength(1);
  });

  it('normalizes provider catalogs, thinking deltas, and terminal timing metadata', () => {
    const init = parseClaudeStreamLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'provider-2',
        model: 'model-2',
        claude_code_version: '2.1.263',
        output_format: 'stream-json',
        tools: ['Bash', 'Read'],
        mcp_servers: ['docs'],
        slash_commands: ['/help'],
        agents: ['reviewer'],
        skills: ['typescript'],
        plugins: ['plugin-a'],
      }),
      context,
    );
    const thinking = parseClaudeStreamLine(
      JSON.stringify({
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 12,
        estimated_tokens_delta: 3,
      }),
      context,
    );
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 2 },
          server_tool_use: { web_search_requests: 1 },
          output_tokens_details: { reasoning_tokens: 1 },
          service_tier: 'standard',
        },
        total_cost_usd: 0.001,
        duration_api_ms: 100,
        ttft_stream_ms: 20,
        first_content_frame_ms: 30,
        iterations: 2,
        speed: 'standard',
      }),
      context,
    );

    expect(init.events.find((event) => event.type === 'provider_info')?.payload).toMatchObject({
      outputFormat: 'stream-json',
      toolCount: 2,
      mcpServerCount: 1,
      slashCommandCount: 1,
      agentCount: 1,
      skillCount: 1,
      pluginCount: 1,
    });
    expect(thinking.events.find((event) => event.type === 'usage_updated')?.payload).toEqual({
      usage: { thinkingTokens: 12, thinkingTokensDelta: 3 },
    });
    expect(result.events.find((event) => event.type === 'usage_updated')?.payload).toMatchObject({
      usage: {
        cacheCreation5mInputTokens: 2,
        reasoningTokens: 1,
        serverToolUseRequests: 1,
        totalCostUsd: 0.001,
        durationApiMs: 100,
        ttftStreamMs: 20,
        firstContentFrameMs: 30,
        iterations: 2,
        speed: 'standard',
      },
    });
  });

  it('maps explicit native milestone records without retaining free-form content', () => {
    const parsed = parseClaudeStreamLine(
      JSON.stringify({
        type: 'milestone_started',
        milestone_id: 'implementation',
        title: 'Implement the feature',
      }),
      context,
    );
    expect(parsed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'milestone_started',
          payload: { milestoneId: 'implementation', title: 'Implement the feature' },
        }),
        expect.objectContaining({
          type: 'provider_event',
          payload: { providerEventType: 'milestone_started' },
        }),
      ]),
    );
  });
});
