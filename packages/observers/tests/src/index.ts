export type VerificationKind = 'test' | 'build' | 'lint' | 'typecheck' | 'unknown';
export type VerificationOutcome = 'passed' | 'failed' | 'interrupted' | 'unknown';

export interface CommandClassification {
  readonly kind: VerificationKind;
  readonly confidence: number;
  readonly reason: string;
}

export interface TestObservation {
  readonly id: string;
  readonly commandName: string;
  readonly kind: VerificationKind;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly outcome: VerificationOutcome;
  readonly verification: 'passed' | 'failed' | 'unknown';
}

export interface TestObserverOptions {
  readonly now?: () => number;
}

export class TestObserver {
  private readonly now: () => number;
  private readonly active = new Map<string, TestObservation>();

  constructor(options: TestObserverOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  start(id: string, commandName: string, startedAt = this.now()): TestObservation {
    const classification = classifyVerificationCommand(commandName);
    const observation: TestObservation = {
      id,
      commandName,
      kind: classification.kind,
      startedAt,
      outcome: 'unknown',
      verification: 'unknown',
    };
    this.active.set(id, observation);
    return observation;
  }

  finish(id: string, exitCode: number, endedAt = this.now()): TestObservation | undefined {
    const started = this.active.get(id);
    if (started === undefined) return undefined;
    this.active.delete(id);
    const durationMs = Math.max(0, endedAt - started.startedAt);
    const outcome =
      exitCode === 0 ? 'passed' : exitCode === 130 || exitCode === 143 ? 'interrupted' : 'failed';
    return {
      ...started,
      endedAt,
      durationMs,
      exitCode,
      outcome,
      verification:
        started.kind === 'unknown' ? 'unknown' : outcome === 'passed' ? 'passed' : 'failed',
    };
  }

  cancel(id: string): TestObservation | undefined {
    const started = this.active.get(id);
    if (started === undefined) return undefined;
    this.active.delete(id);
    return { ...started, outcome: 'interrupted', verification: 'unknown' };
  }
}

export function classifyVerificationCommand(commandName: string): CommandClassification {
  const command = normalizeCommand(commandName);
  if (command === 'test' || command === 'build' || command === 'lint' || command === 'typecheck') {
    return { kind: command, confidence: 0.9, reason: 'Normalized verification command kind.' };
  }
  if (matches(command, TEST_RULES)) {
    return { kind: 'test', confidence: 0.9, reason: 'Known test command pattern.' };
  }
  if (matches(command, TYPECHECK_RULES)) {
    return { kind: 'typecheck', confidence: 0.9, reason: 'Known typecheck command pattern.' };
  }
  if (matches(command, BUILD_RULES)) {
    return { kind: 'build', confidence: 0.9, reason: 'Known build command pattern.' };
  }
  if (matches(command, LINT_RULES)) {
    return { kind: 'lint', confidence: 0.9, reason: 'Known lint command pattern.' };
  }
  return {
    kind: 'unknown',
    confidence: 0.2,
    reason: 'Command was not in the known verification rule table.',
  };
}

function normalizeCommand(commandName: string): string {
  return commandName.trim().toLowerCase().replaceAll('\\', '/').replace(/\s+/g, ' ');
}

function matches(command: string, rules: readonly RegExp[]): boolean {
  return rules.some((rule) => rule.test(command));
}

const TEST_RULES = [
  /(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?test(\s|$)/,
  /(^|\s)(vitest|jest|mocha|pytest|cargo test|go test|dotnet test)(\s|$)/,
];
const TYPECHECK_RULES = [
  /(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?typecheck(\s|$)/,
  /(^|\s)(tsc|pyright|mypy)(\s|$).*--noemit(\s|$)/,
];
const BUILD_RULES = [
  /(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?build(\s|$)/,
  /(^|\s)(vite|webpack|rollup|esbuild)(\s|$).*build(\s|$)/,
];
const LINT_RULES = [
  /(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?lint(\s|$)/,
  /(^|\s)(eslint|prettier)(\s|$)/,
];
