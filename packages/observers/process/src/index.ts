import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessState = 'running' | 'exited' | 'unknown';
export type ProcessObservationKind = 'started' | 'finished';

export interface ProcessChild {
  readonly pid: number;
  readonly parentPid: number;
  readonly name?: string;
}

export interface ProcessInspection {
  readonly state: ProcessState;
  readonly exitCode?: number;
  readonly signal?: string;
  /** Direct and transitive descendants, when the platform inspector supports it. */
  readonly children?: readonly ProcessChild[];
}

export interface ProcessObservation {
  readonly kind: ProcessObservationKind;
  readonly pid: number;
  readonly observedAt: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly scope?: 'root' | 'child';
  readonly parentPid?: number;
  readonly name?: string;
  readonly reason: 'spawned' | 'exit' | 'poll_exit' | 'child_spawned' | 'child_exit';
}

export interface ProcessObserverOptions {
  readonly pid: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  /** Observe descendants of the wrapper process when the platform supports it. */
  readonly observeChildren?: boolean;
  readonly inspect?: (pid: number) => ProcessInspection | Promise<ProcessInspection>;
  readonly onObservation: (observation: ProcessObservation) => void;
}

export class ProcessObserver {
  private readonly pid: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly observeChildren: boolean;
  private readonly inspect: NonNullable<ProcessObserverOptions['inspect']>;
  private readonly onObservation: ProcessObserverOptions['onObservation'];
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt: number | undefined;
  private finished = false;
  private pollPromise: Promise<ProcessInspection> | undefined;
  private readonly children = new Map<number, ProcessChild>();

  constructor(options: ProcessObserverOptions) {
    if (!Number.isInteger(options.pid) || options.pid <= 0) {
      throw new RangeError('pid must be a positive integer.');
    }
    this.pid = options.pid;
    this.pollMs = validatePollInterval(options.pollMs ?? 1_000);
    this.now = options.now ?? Date.now;
    this.observeChildren = options.observeChildren ?? false;
    this.inspect =
      options.inspect ?? (this.observeChildren ? inspectProcessWithChildren : inspectProcess);
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
    if (this.pollPromise !== undefined) return this.pollPromise;
    const poll = (async (): Promise<ProcessInspection> => {
      const inspection = await this.inspect(this.pid);
      if (this.startedAt === undefined || this.finished) return inspection;
      if (this.observeChildren) this.reconcileChildren(inspection.children, this.now());
      if (inspection.state === 'exited')
        this.finish(inspection.exitCode, inspection.signal, 'poll_exit');
      return inspection;
    })();
    this.pollPromise = poll;
    try {
      return await poll;
    } finally {
      if (this.pollPromise === poll) this.pollPromise = undefined;
    }
  }

  notifyExit(exitCode?: number, signal?: string, endedAt = this.now()): void {
    if (this.startedAt === undefined || this.finished) return;
    this.finish(exitCode, signal, 'exit', endedAt);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.children.clear();
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
    if (this.observeChildren) this.finishChildren(endedAt);
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

  private reconcileChildren(
    children: readonly ProcessChild[] | undefined,
    observedAt: number,
  ): void {
    if (children === undefined) return;
    const next = new Map(children.map((child) => [child.pid, child]));
    for (const child of next.values()) {
      if (this.children.has(child.pid)) continue;
      this.onObservation({
        kind: 'started',
        pid: child.pid,
        parentPid: child.parentPid,
        ...(child.name === undefined ? {} : { name: child.name }),
        observedAt,
        startedAt: observedAt,
        scope: 'child',
        reason: 'child_spawned',
      });
    }
    for (const child of this.children.values()) {
      if (next.has(child.pid)) continue;
      this.onObservation({
        kind: 'finished',
        pid: child.pid,
        parentPid: child.parentPid,
        ...(child.name === undefined ? {} : { name: child.name }),
        observedAt,
        startedAt: childStartedAt(child, observedAt),
        endedAt: observedAt,
        scope: 'child',
        reason: 'child_exit',
      });
    }
    this.children.clear();
    for (const child of next.values()) this.children.set(child.pid, child);
  }

  private finishChildren(endedAt: number): void {
    for (const child of this.children.values()) {
      this.onObservation({
        kind: 'finished',
        pid: child.pid,
        parentPid: child.parentPid,
        ...(child.name === undefined ? {} : { name: child.name }),
        observedAt: endedAt,
        startedAt: childStartedAt(child, endedAt),
        endedAt,
        scope: 'child',
        reason: 'child_exit',
      });
    }
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

async function inspectProcessWithChildren(pid: number): Promise<ProcessInspection> {
  const tree = await inspectProcessTree(pid);
  if (tree !== undefined) return tree;
  return inspectProcess(pid);
}

/**
 * Inspect a wrapper and its descendants without reading command lines or
 * environments. The platform commands return only PID, parent PID and the
 * executable name. Failure is intentionally treated as an unavailable child
 * view; root lifecycle observation still continues through process.kill().
 */
async function inspectProcessTree(pid: number): Promise<ProcessInspection | undefined> {
  try {
    const rows =
      process.platform === 'win32' ? await inspectWindowsProcesses() : await inspectUnixProcesses();
    const byParent = new Map<number, ProcessChild[]>();
    for (const row of rows) {
      const children = byParent.get(row.parentPid) ?? [];
      children.push(row);
      byParent.set(row.parentPid, children);
    }
    const children: ProcessChild[] = [];
    const queue = [...(byParent.get(pid) ?? [])];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const child = queue.shift();
      if (child === undefined || visited.has(child.pid)) continue;
      visited.add(child.pid);
      children.push(child);
      queue.push(...(byParent.get(child.pid) ?? []));
    }
    return {
      state: rows.some((row) => row.pid === pid) ? 'running' : 'exited',
      children,
    };
  } catch {
    return undefined;
  }
}

async function inspectWindowsProcesses(): Promise<readonly ProcessChild[]> {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
  const result = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 800 },
  );
  return parseWindowsProcessRows(result.stdout);
}

async function inspectUnixProcesses(): Promise<readonly ProcessChild[]> {
  const result = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm='], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 800,
  });
  return parseUnixProcessRows(result.stdout);
}

function parseWindowsProcessRows(output: string): readonly ProcessChild[] {
  const parsed: unknown = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const value = row as Record<string, unknown>;
    const pid = numberValue(value.ProcessId);
    const parentPid = numberValue(value.ParentProcessId);
    if (pid === undefined || parentPid === undefined) return [];
    const name = typeof value.Name === 'string' && value.Name.length > 0 ? value.Name : undefined;
    return [{ pid, parentPid, ...(name === undefined ? {} : { name }) }];
  });
}

function parseUnixProcessRows(output: string): readonly ProcessChild[] {
  const rows: ProcessChild[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const name = match[3]?.trim();
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid < 0) {
      continue;
    }
    rows.push({ pid, parentPid, ...(name === undefined ? {} : { name }) });
  }
  return rows;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function childStartedAt(child: ProcessChild, fallback: number): number {
  // The platform process listing does not expose a stable creation timestamp.
  // The first observation is therefore the conservative lower bound.
  void child;
  return fallback;
}

function validatePollInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('pollMs must be positive.');
  return value;
}
