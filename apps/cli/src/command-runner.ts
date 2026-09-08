import type { CliCommand } from './index.js';
import { formatCliHelp } from './index.js';
import type { MockRunResult } from './mock-runner.js';
import type { RecoverySummary } from './recover-runner.js';
import { formatServerJson, type ServerClient } from './server-client.js';

export interface CliCommandRunnerOptions {
  readonly client?: Pick<ServerClient, 'listSessions' | 'getSession' | 'listEvents'>;
  readonly runMock?: (fixture: string) => Promise<MockRunResult>;
  readonly recover?: () => Promise<RecoverySummary>;
  readonly runAdapter?: (adapter: string, args: readonly string[]) => Promise<number>;
  readonly runInteractive?: (
    adapter: 'claude' | 'codex',
    args: readonly string[],
  ) => Promise<number>;
  readonly start?: () => Promise<number>;
  readonly write: (text: string) => void;
}

export class CliExecutionError extends Error {
  constructor(
    message: string,
    readonly code: 'missing_runtime' | 'not_implemented' | 'invalid_input',
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'CliExecutionError';
  }
}

export async function executeCliCommand(
  command: CliCommand,
  options: CliCommandRunnerOptions,
): Promise<number> {
  if (command.kind === 'help') {
    options.write(`${formatCliHelp()}\n`);
    return 0;
  }
  if (command.kind === 'sessions') {
    const client = requireClient(options);
    options.write(formatServerJson(await client.listSessions()));
    return 0;
  }
  if (command.kind === 'recover') {
    if (options.recover === undefined) {
      throw new CliExecutionError('Recovery runner is not configured.', 'missing_runtime');
    }
    const result = await options.recover();
    options.write(formatServerJson(result));
    return 0;
  }
  if (command.kind === 'show') {
    const client = requireClient(options);
    const [session, events] = await Promise.all([
      client.getSession(command.sessionId),
      client.listEvents(command.sessionId),
    ]);
    options.write(formatServerJson({ session, events }));
    return 0;
  }
  if (command.kind === 'run-mock') {
    if (options.runMock === undefined) {
      throw new CliExecutionError('Mock runner is not configured.', 'missing_runtime');
    }
    const result = await options.runMock(command.fixture);
    options.write(formatServerJson(result));
    return result.exitCode;
  }
  if (command.kind === 'run') {
    if (options.runAdapter === undefined) {
      throw new CliExecutionError('Provider runner is not configured.', 'missing_runtime');
    }
    return options.runAdapter(command.adapter, command.args);
  }
  if (command.kind === 'interactive') {
    if (options.runInteractive === undefined) {
      throw new CliExecutionError('Interactive runner is not configured.', 'missing_runtime');
    }
    return options.runInteractive(command.adapter, command.args);
  }
  if (command.kind === 'start') {
    if (options.start !== undefined) return options.start();
    throw new CliExecutionError('The start command is not wired yet.', 'not_implemented');
  }
  throw new CliExecutionError('The selected provider runner is not wired yet.', 'not_implemented');
}

function requireClient(
  options: CliCommandRunnerOptions,
): Pick<ServerClient, 'listSessions' | 'getSession' | 'listEvents'> {
  if (options.client === undefined) {
    throw new CliExecutionError('Server client is not configured.', 'missing_runtime');
  }
  return options.client;
}
