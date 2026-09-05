import type { RunningServer, StartServerOptions } from '@agentscope/server/runtime';
import { startServer } from '@agentscope/server/runtime';

import { resolveCliConfig, type CliConfig, type CliConfigOverrides } from './config.js';

export interface ShutdownSignals {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface StartCommandRuntimeOptions extends CliConfigOverrides {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
  readonly startServer?: (options: StartServerOptions) => Promise<RunningServer>;
  readonly signals?: ShutdownSignals;
}

export async function runStartCommand(options: StartCommandRuntimeOptions = {}): Promise<number> {
  const config = resolveCliConfig(options);
  const server = await (options.startServer ?? startServer)(toStartServerOptions(config));
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(`AgentScope server listening at ${server.address}\n`);
  return waitForShutdown(server, options.signals ?? process);
}

export function toStartServerOptions(config: CliConfig): StartServerOptions {
  return {
    filename: config.database,
    host: config.host,
    port: config.port,
  };
}

export function waitForShutdown(server: RunningServer, signals: ShutdownSignals): Promise<number> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const handleSignal = () => {
      if (finished) return;
      finished = true;
      signals.removeListener('SIGINT', handleSignal);
      signals.removeListener('SIGTERM', handleSignal);
      void server.close().then(() => resolve(0), reject);
    };
    signals.once('SIGINT', handleSignal);
    signals.once('SIGTERM', handleSignal);
  });
}
