import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  readonly dashboard?: boolean;
  readonly startDashboard?: (options: StartDashboardOptions) => Promise<RunningDashboard>;
  readonly signals?: ShutdownSignals;
}

export interface StartDashboardOptions {
  readonly cwd: string;
  readonly host: string;
  readonly port: number;
  readonly serverUrl: string;
}

export interface RunningDashboard {
  readonly address: string;
  readonly close: () => Promise<void>;
  readonly waitForExit: () => Promise<number | null>;
}

export async function runStartCommand(options: StartCommandRuntimeOptions = {}): Promise<number> {
  const config = resolveCliConfig(options);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const signals = options.signals ?? process;
  let shutdownRequested = false;
  const requestShutdown = () => {
    shutdownRequested = true;
  };
  signals.once('SIGINT', requestShutdown);
  signals.once('SIGTERM', requestShutdown);
  let server: RunningServer | undefined;
  let dashboard: RunningDashboard | undefined;
  try {
    server = await (options.startServer ?? startServer)(toStartServerOptions(config));
    if (options.dashboard === true) {
      dashboard = await (options.startDashboard ?? launchDashboard)({
        cwd: config.workspacePath,
        host: '127.0.0.1',
        port: config.dashboardPort,
        serverUrl: config.serverUrl,
      });
    }
  } catch (error) {
    signals.removeListener('SIGINT', requestShutdown);
    signals.removeListener('SIGTERM', requestShutdown);
    await dashboard?.close();
    await server?.close();
    throw error;
  }
  signals.removeListener('SIGINT', requestShutdown);
  signals.removeListener('SIGTERM', requestShutdown);
  if (server === undefined) throw new Error('AgentScope server did not start.');
  if (shutdownRequested) {
    await dashboard?.close();
    await server.close();
    return 0;
  }
  write(`AgentScope server listening at ${server.address}\n`);
  if (dashboard !== undefined) write(`AgentScope Dashboard listening at ${dashboard.address}\n`);
  return waitForShutdown(server, signals, dashboard);
}

export function toStartServerOptions(config: CliConfig): StartServerOptions {
  return {
    filename: config.database,
    host: config.host,
    port: config.port,
  };
}

export function waitForShutdown(
  server: RunningServer,
  signals: ShutdownSignals,
  dashboard?: RunningDashboard,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = async (exitCode: number) => {
      if (finished) return;
      finished = true;
      signals.removeListener('SIGINT', handleSignal);
      signals.removeListener('SIGTERM', handleSignal);
      try {
        await dashboard?.close();
        await server.close();
        resolve(exitCode);
      } catch (error) {
        reject(error);
      }
    };
    const handleSignal = () => void finish(0);
    signals.once('SIGINT', handleSignal);
    signals.once('SIGTERM', handleSignal);
    if (dashboard !== undefined) void dashboard.waitForExit().then(() => finish(1), reject);
  });
}

export async function launchDashboard(options: StartDashboardOptions): Promise<RunningDashboard> {
  const packageManager = resolvePackageManager();
  const child = spawn(
    packageManager.executable,
    [
      ...packageManager.args,
      '--filter',
      '@agentscope/dashboard',
      'exec',
      'vite',
      '--host',
      options.host,
      '--port',
      String(options.port),
      '--strictPort',
    ],
    {
      cwd: path.resolve(options.cwd),
      env: { ...process.env, AGENTSCOPE_SERVER_URL: options.serverUrl },
      shell: false,
      stdio: 'inherit',
      windowsHide: false,
    },
  );
  await waitForSpawn(child);
  let closed = false;
  let closeResolve: (() => void) | undefined;
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      closeResolve?.();
      resolve(code);
    });
  });
  return {
    address: `http://${options.host}:${options.port}`,
    close: async () => {
      if (closed) return closePromise;
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        closeResolve?.();
        return closePromise;
      }
      await terminateProcessTree(child);
      return closePromise;
    },
    waitForExit: () => exitPromise,
  };
}

interface ResolvedPackageManager {
  readonly executable: string;
  readonly args: readonly string[];
}

function resolvePackageManager(): ResolvedPackageManager {
  if (process.platform !== 'win32') return { executable: 'pnpm', args: [] };
  const directories = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of directories) {
    const shim = path.join(directory, 'pnpm.cmd');
    if (!fs.existsSync(shim)) continue;
    const text = fs.readFileSync(shim, 'utf8');
    const scriptTarget = text.match(/"([^"\r\n]+\.js)"\s+%\*/iu)?.[1];
    if (scriptTarget === undefined) continue;
    const script = path.resolve(scriptTarget.replace(/%~?dp0%/giu, path.dirname(shim)));
    if (fs.existsSync(script)) return { executable: process.execPath, args: [script] };
  }
  const executable = directories
    .map((directory) => path.join(directory, 'pnpm.exe'))
    .find((candidate) => fs.existsSync(candidate));
  if (executable !== undefined) return { executable, args: [] };
  throw new Error('Could not resolve a Windows pnpm executable without a shell shim.');
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill();
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('close', () => resolve());
    killer.once('error', () => resolve());
  });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
}
