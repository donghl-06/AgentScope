export type CliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'start' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'show'; readonly sessionId: string }
  | { readonly kind: 'run'; readonly adapter: string; readonly args: readonly string[] }
  | { readonly kind: 'run-mock'; readonly fixture: string };

export * from './process-runner.js';
export * from './mock-runner.js';

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
      expectNoArguments('start', rest);
      return { kind: 'start' };
    case 'sessions':
      expectNoArguments('sessions', rest);
      return { kind: 'sessions' };
    case 'show':
      if (rest.length !== 1 || rest[0] === undefined || rest[0].startsWith('-')) {
        throw new CliUsageError('Usage: agent-scope show <session-id>');
      }
      return { kind: 'show', sessionId: rest[0] };
    case 'run':
      return parseRun(rest);
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

export function formatCliHelp(): string {
  return [
    'Usage: agent-scope <command>',
    '',
    'Commands:',
    '  start                         Start the local AgentScope server.',
    '  run <adapter> -- <args...>   Run an adapter and preserve argument boundaries.',
    '  run mock --fixture <name>    Run a deterministic mock fixture.',
    '  sessions                     List stored sessions.',
    '  show <session-id>            Show one stored session.',
    '  --help                       Show this help.',
  ].join('\n');
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

function expectNoArguments(command: string, args: readonly string[]): void {
  if (args.length > 0) throw new CliUsageError(`Usage: agent-scope ${command}`);
}
