import { describe, expect, it } from 'vitest';

import { CodexAppServerAdapter } from './adapter.js';

describe('Codex app-server adapter', () => {
  it('runs a local JSON-RPC server and normalizes its streaming events', async () => {
    const server = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'Codex test/0.0.1' } }) + '\\n');
            process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: 'thread-1', model: 'test-model', cliVersion: '0.0.1' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-1' } } }) + '\\n');
          }
          if (message.method === 'thread/start') {
            process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } }) + '\\n');
          }
          if (message.method === 'turn/start') {
            process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test -- hidden', status: 'inProgress' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', exitCode: 0 } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }) + '\\n');
          }
        }
      });
    `;
    const adapter = new CodexAppServerAdapter({
      executable: process.execPath,
      commandPrefix: ['-e', server],
      classifyCommand: () => 'test',
    });
    const attached = await adapter.start({
      sessionId: 'session-1',
      workspacePath: process.cwd(),
      args: ['Reply with APP_SERVER_OK'],
    });
    const events = [];
    for await (const event of attached.events()) {
      events.push(event);
      if (event.type === 'session_finished') break;
    }
    await attached.detach();

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'provider_info',
      'provider_event',
      'provider_event',
      'turn_started',
      'provider_event',
      'tool_call_started',
      'command_started',
      'provider_event',
      'tool_call_finished',
      'command_finished',
      'provider_event',
      'turn_finished',
      'session_finished',
    ]);
    expect(events.find((event) => event.type === 'provider_info')?.payload).toMatchObject({
      providerSessionId: 'thread-1',
      model: 'test-model',
      cliVersion: '0.0.1',
      outputFormat: 'app-server',
    });
    expect(JSON.stringify(events)).not.toContain('hidden');
  });

  it('advertises native app-server capabilities', () => {
    expect(new CodexAppServerAdapter().capabilities()).toEqual({
      structuredEvents: true,
      toolCalls: true,
      fileEvents: true,
      commandEvents: true,
      tokenUsage: true,
      sessionInfo: true,
      milestones: true,
    });
  });

  it('resumes a provider thread and declines unattended approval requests safely', async () => {
    const server = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
          } else if (message.method === 'thread/resume') {
            process.stderr.write('RESUME:' + JSON.stringify(message.params) + '\\n');
            process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-existing' } } }) + '\\n');
          } else if (message.method === 'turn/start') {
            process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-2' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'item/started', params: { item: { id: 'cmd-2', type: 'commandExecution' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ id: 50, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-existing', turnId: 'turn-2', itemId: 'cmd-2' } }) + '\\n');
          } else if (message.id === 50) {
            process.stderr.write('DECISION:' + JSON.stringify(message.result) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed' } } }) + '\\n');
          }
        }
      });
    `;
    let stderr = '';
    const adapter = new CodexAppServerAdapter({
      executable: process.execPath,
      commandPrefix: ['-e', server],
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    const attached = await adapter.start({
      sessionId: 'session-2',
      workspacePath: process.cwd(),
      args: ['--resume', 'thread-existing', 'Continue the task'],
    });
    const events = [];
    for await (const event of attached.events()) {
      events.push(event);
      if (event.type === 'session_finished') break;
    }
    await attached.detach();

    expect(stderr).toContain('RESUME:');
    expect(stderr).toContain('"threadId":"thread-existing"');
    expect(stderr).toContain('DECISION:{"decision":"decline"}');
    expect(events.some((event) => event.type === 'blocked')).toBe(true);
    expect(events.some((event) => event.type === 'session_finished')).toBe(true);
  });

  it('sends turn/interrupt before the bounded process fallback', async () => {
    const server = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
          } else if (message.method === 'thread/start') {
            process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-stop' } } }) + '\\n');
          } else if (message.method === 'turn/start') {
            process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-stop' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-stop', status: 'inProgress' } } }) + '\\n');
          } else if (message.method === 'turn/interrupt') {
            process.stderr.write('INTERRUPT:' + JSON.stringify(message.params) + '\\n');
            process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-stop', status: 'interrupted' } } }) + '\\n');
          }
        }
      });
    `;
    let stderr = '';
    const adapter = new CodexAppServerAdapter({
      executable: process.execPath,
      commandPrefix: ['-e', server],
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    const attached = await adapter.start({
      sessionId: 'session-stop',
      workspacePath: process.cwd(),
      args: ['Stop after the turn starts'],
    });
    for await (const event of attached.events()) {
      if (event.type === 'turn_started') {
        await attached.stop();
        break;
      }
    }
    await attached.detach();

    expect(stderr).toContain('INTERRUPT:');
    expect(stderr).toContain('"threadId":"thread-stop"');
    expect(stderr).toContain('"turnId":"turn-stop"');
  });
});
