import path from 'node:path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_DATABASE = '.agentscope/agentscope.db';
export const DEFAULT_DASHBOARD_PORT = 5173;

export interface CliConfigOverrides {
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly dashboardPort?: number;
}

export interface CliConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly serverUrl: string;
  readonly workspacePath: string;
  readonly dashboardPort: number;
}

export interface ResolveCliConfigOptions extends CliConfigOverrides {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveCliConfig(options: ResolveCliConfigOptions = {}): CliConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const host = options.host ?? env.AGENTSCOPE_HOST ?? DEFAULT_HOST;
  const port = options.port ?? parsePort(env.AGENTSCOPE_PORT, DEFAULT_PORT);
  const database = options.database ?? env.AGENTSCOPE_DATABASE ?? DEFAULT_DATABASE;
  const dashboardPort =
    options.dashboardPort ?? parsePort(env.AGENTSCOPE_DASHBOARD_PORT, DEFAULT_DASHBOARD_PORT);
  const serverUrl = env.AGENTSCOPE_SERVER_URL ?? `http://${host}:${port}`;

  validateHost(host);
  validatePort(port);
  if (database.trim().length === 0) throw new CliConfigError('Database path must not be empty.');

  return {
    host,
    port,
    database: database === ':memory:' ? ':memory:' : path.resolve(cwd, database),
    serverUrl,
    workspacePath: cwd,
    dashboardPort,
  };
}

export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  validatePort(port);
  return port;
}

function validateHost(host: string): void {
  if (host.trim().length === 0) throw new CliConfigError('Host must not be empty.');
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliConfigError('Port must be an integer between 0 and 65535.');
  }
}
