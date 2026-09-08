export type CliCommand =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'start';
      readonly host?: string;
      readonly port?: number;
      readonly database?: string;
      readonly dashboard?: boolean;
      readonly dashboardPort?: number;
    }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'recover' }
  | { readonly kind: 'show'; readonly sessionId: string }
  | { readonly kind: 'run'; readonly adapter: string; readonly args: readonly string[] }
  | {
      readonly kind: 'interactive';
      readonly adapter: 'claude' | 'codex';
      readonly args: readonly string[];
      readonly acceptApiKey?: boolean;
    }
  | { readonly kind: 'run-mock'; readonly fixture: string };

export * from './process-runner.js';
export * from './mock-runner.js';
export * from './server-client.js';
export * from './config.js';
export * from './start-runtime.js';
export * from './provider-runner.js';
export * from './recover-runner.js';
export * from './command-runner.js';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return { kind: 'help' };

  switch (command) {
    case 'start':
      return parseStart(rest);
    case 'sessions':
      expectNoArguments('sessions', rest);
      return { kind: 'sessions' };
    case 'recover':
      expectNoArguments('recover', rest);
      return { kind: 'recover' };
    case 'show':
      if (rest.length !== 1 || rest[0] === undefined || rest[0].startsWith('-')) {
        throw new CliUsageError('Usage: agent-scope show <session-id>');
      }
      return { kind: 'show', sessionId: rest[0] };
    case 'run':
      return parseRun(rest);
    case 'claude':
      return parseInteractive('claude', rest);
    case 'codex':
      return parseInteractive('codex', rest);
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

export function formatCliHelp(): string {
  return [
    'Usage: agent-scope <command>',
    '',
    'Commands:',
    '  start                         Start the local server and Dashboard.',
    '  run <adapter> -- <args...>   Run an adapter and preserve argument boundaries.',
    '  claude [--agent-scope-accept-api-key] [args...]',
    '                                Run Claude Code in a monitored interactive PTY.',
    '  codex [args...]                Run Codex CLI in a monitored interactive PTY.',
    '  run mock --fixture <name>    Run a deterministic mock fixture.',
    '  sessions                     List stored sessions.',
    '  recover                      Mark stale sessions as interrupted.',
    '  show <session-id>            Show one stored session.',
    '  --help                       Show this help.',
  ].join('\n');
}

function parseInteractive(
  adapter: 'claude' | 'codex',
  argv: readonly string[],
): Extract<CliCommand, { kind: 'interactive' }> {
  const args: string[] = [];
  let acceptApiKey = false;
  for (const argument of argv) {
    if (argument === '--agent-scope-accept-api-key') {
      acceptApiKey = true;
    } else {
      args.push(argument);
    }
  }
  return {
    kind: 'interactive',
    adapter,
    args,
    ...(acceptApiKey ? { acceptApiKey: true } : {}),
  };
}

function parseRun(argv: readonly string[]): CliCommand {
  const adapter = argv[0];
  if (adapter === undefined || adapter.startsWith('-')) {
    throw new CliUsageError('Usage: agent-scope run <adapter> -- <args...>');
  }
  const rest = argv.slice(1);
  if (adapter === 'mock' && rest[0] === '--fixture') {
    if (rest.length !== 2 || rest[1] === undefined || rest[1].startsWith('-')) {
      throw new CliUsageError('Usage: agent-scope run mock --fixture <name>');
    }
    return { kind: 'run-mock', fixture: rest[1] };
  }
  const separator = rest.indexOf('--');
  if (separator === -1) {
    throw new CliUsageError('Usage: agent-scope run <adapter> -- <args...>');
  }
  if (rest.slice(0, separator).length > 0) {
    throw new CliUsageError('Options before -- are not supported for adapter runs.');
  }
  return { kind: 'run', adapter, args: rest.slice(separator + 1) };
}

function parseStart(argv: readonly string[]): Extract<CliCommand, { kind: 'start' }> {
  let host: string | undefined;
  let port: number | undefined;
  let database: string | undefined;
  let dashboard: boolean | undefined;
  let dashboardPort: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--no-dashboard') {
      dashboard = false;
      continue;
    }
    if (flag === '--dashboard') {
      dashboard = true;
      continue;
    }
    if (
      flag === '--host' ||
      flag === '--port' ||
      flag === '--database' ||
      flag === '--db' ||
      flag === '--dashboard-port'
    ) {
      if (value === undefined || value.startsWith('-')) {
        throw new CliUsageError(
          'Usage: agent-scope start [--host <host>] [--port <port>] [--database <path>] [--dashboard-port <port>] [--no-dashboard]',
        );
      }
      if (flag === '--host') host = value;
      else if (flag === '--port') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          throw new CliUsageError('The --port value must be an integer between 0 and 65535.');
        }
        port = parsed;
      } else if (flag === '--dashboard-port') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          throw new CliUsageError(
            'The --dashboard-port value must be an integer between 0 and 65535.',
          );
        }
        dashboardPort = parsed;
      } else database = value;
      index += 1;
      continue;
    }
    throw new CliUsageError(
      'Usage: agent-scope start [--host <host>] [--port <port>] [--database <path>] [--dashboard-port <port>] [--no-dashboard]',
    );
  }
  return {
    kind: 'start',
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(database === undefined ? {} : { database }),
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(dashboardPort === undefined ? {} : { dashboardPort }),
  };
}

function expectNoArguments(command: string, args: readonly string[]): void {
  if (args.length > 0) throw new CliUsageError(`Usage: agent-scope ${command}`);
}
