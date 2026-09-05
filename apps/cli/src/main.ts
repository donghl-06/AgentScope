#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import { MOCK_FIXTURES, type MockFixtureName } from '@agentscope/adapter-mock';

import { CliConfigError, resolveCliConfig } from './config.js';
import { CliExecutionError, executeCliCommand } from './command-runner.js';
import { CliUsageError, formatCliHelp, parseCliArgs, type CliCommand } from './index.js';
import { runMockFixture } from './mock-runner.js';
import { runProvider } from './provider-runner.js';
import { recoverSessions } from './recover-runner.js';
import { ServerClient } from './server-client.js';
import { runStartCommand } from './start-runtime.js';

export interface CliMainOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  readonly writeStdout?: (chunk: string) => void;
  readonly writeStderr?: (chunk: string) => void;
  readonly start?: CliMainStartOptions;
}

export interface CliMainStartOptions {
  readonly run?: typeof runStartCommand;
}

export async function runCli(options: CliMainOptions = {}): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
  const writeStdout = options.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeStderr = options.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  try {
    const command = parseCliArgs(options.argv ?? process.argv.slice(2));
    if (command.kind === 'help') {
      write(`${formatCliHelp()}\n`);
      return 0;
    }
    const config = resolveCliConfig({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(command.kind === 'start'
        ? { host: command.host, port: command.port, database: command.database }
        : {}),
    });
    return await executeCliCommand(command, {
      write,
      ...(command.kind === 'start'
        ? {
            start: () =>
              (options.start?.run ?? runStartCommand)({
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.env === undefined ? {} : { env: options.env }),
                host: config.host,
                port: config.port,
                database: config.database,
                write,
              }),
          }
        : {}),
      ...(command.kind === 'sessions' || command.kind === 'show'
        ? { client: new ServerClient({ baseUrl: config.serverUrl }) }
        : {}),
      ...(command.kind === 'recover'
        ? { recover: async () => recoverSessions(config.database) }
        : {}),
      ...(command.kind === 'run-mock'
        ? {
            runMock: (fixture: string) => {
              if (!isMockFixtureName(fixture)) {
                throw new CliExecutionError(`Unknown mock fixture: ${fixture}`, 'invalid_input');
              }
              return runMockFixture({
                filename: config.database,
                fixture,
                sessionId: randomUUID(),
                workspacePath: config.workspacePath,
              });
            },
          }
        : {}),
      ...(command.kind === 'run'
        ? {
            runAdapter: (adapter: string, args: readonly string[]) => {
              if (adapter !== 'claude' && adapter !== 'codex') {
                throw new CliExecutionError(`Unsupported adapter: ${adapter}`, 'not_implemented');
              }
              return runProvider({
                adapter,
                args,
                filename: config.database,
                workspacePath: config.workspacePath,
                writeStdout,
                writeStderr,
              }).then((result) => result.exitCode);
            },
          }
        : {}),
    });
  } catch (error) {
    const exitCode = error instanceof CliExecutionError ? error.exitCode : 2;
    const message = error instanceof Error ? error.message : String(error);
    writeError(`${message}\n`);
    return exitCode;
  }
}

function isMockFixtureName(value: string): value is MockFixtureName {
  return Object.prototype.hasOwnProperty.call(MOCK_FIXTURES, value);
}

if (import.meta.main) {
  process.exitCode = await runCli();
}

export { CliConfigError, CliExecutionError, CliUsageError };
export type { CliCommand };
