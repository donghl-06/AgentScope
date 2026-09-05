export type ProcessState = 'running' | 'exited' | 'unknown';
export type ProcessObservationKind = 'started' | 'finished';

export interface ProcessInspection {
  readonly state: ProcessState;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface ProcessObservation {
  readonly kind: ProcessObservationKind;
  readonly pid: number;
  readonly observedAt: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly reason: 'spawned' | 'exit' | 'poll_exit';
}

export interface ProcessObserverOptions {
  readonly pid: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly inspect?: (pid: number) => ProcessInspection | Promise<ProcessInspection>;
  readonly onObservation: (observation: ProcessObservation) => void;
}

export class ProcessObserver {
  private readonly pid: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly inspect: NonNullable<ProcessObserverOptions['inspect']>;
  private readonly onObservation: ProcessObserverOptions['onObservation'];
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt: number | undefined;
  private finished = false;
  private polling = false;

  constructor(options: ProcessObserverOptions) {
    if (!Number.isInteger(options.pid) || options.pid <= 0) {
      throw new RangeError('pid must be a positive integer.');
    }
    this.pid = options.pid;
    this.pollMs = validatePollInterval(options.pollMs ?? 1_000);
    this.now = options.now ?? Date.now;
    this.inspect = options.inspect ?? inspectProcess;
    this.onObservation = options.onObservation;
  }

  start(startedAt = this.now()): void {
    if (this.startedAt !== undefined) return;
    this.startedAt = startedAt;
    this.onObservation({
      kind: 'started',
      pid: this.pid,
      observedAt: startedAt,
      startedAt,
      reason: 'spawned',
    });
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.timer.unref?.();
  }

  async pollOnce(): Promise<ProcessInspection> {
    const inspection = await this.inspect(this.pid);
    if (this.startedAt === undefined || this.finished || this.polling) return inspection;
    if (inspection.state !== 'exited') return inspection;
    this.finish(inspection.exitCode, inspection.signal, 'poll_exit');
    return inspection;
  }

  notifyExit(exitCode?: number, signal?: string, endedAt = this.now()): void {
    if (this.startedAt === undefined || this.finished) return;
    this.finish(exitCode, signal, 'exit', endedAt);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  private finish(
    exitCode: number | undefined,
    signal: string | undefined,
    reason: 'exit' | 'poll_exit',
    endedAt = this.now(),
  ): void {
    if (this.startedAt === undefined || this.finished) return;
    this.finished = true;
    this.stop();
    this.onObservation({
      kind: 'finished',
      pid: this.pid,
      observedAt: endedAt,
      startedAt: this.startedAt,
      endedAt,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
      reason,
    });
  }
}

async function inspectProcess(pid: number): Promise<ProcessInspection> {
  try {
    process.kill(pid, 0);
    return { state: 'running' };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'ESRCH' ? { state: 'exited' } : { state: 'unknown' };
  }
}

function validatePollInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('pollMs must be positive.');
  return value;
}
