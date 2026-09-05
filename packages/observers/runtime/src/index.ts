import {
  FilesystemObserver,
  type FileObservation,
  type FileWatchFactory,
} from '@agentscope/observer-filesystem';
import {
  ObserverEvidenceLedger,
  type ObserverEvidence,
  type ObserverEvidenceKind,
  type ObserverEvidenceSource,
} from '@agentscope/observer-fusion';
import {
  GitObserver,
  type GitChangeSet,
  type GitCommandRunner,
  type GitSnapshot,
} from '@agentscope/observer-git';
import {
  ProcessObserver,
  type ProcessInspection,
  type ProcessObservation,
} from '@agentscope/observer-process';
import {
  TestObserver,
  type TestObservation,
} from '@agentscope/observer-tests';

export interface ObserverRuntimeProcessOptions {
  readonly pid: number;
  readonly startedAt?: number;
  readonly pollMs?: number;
  readonly inspect?: (pid: number) => ProcessInspection | Promise<ProcessInspection>;
}

export interface ObserverRuntimeFileOptions {
  readonly debounceMs?: number;
  readonly watchFactory?: FileWatchFactory;
}

export interface ObserverRuntimeGitOptions {
  readonly run?: GitCommandRunner;
}

export interface ObserverRuntimeOptions {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly now?: () => number;
  readonly process?: ObserverRuntimeProcessOptions;
  readonly file?: ObserverRuntimeFileOptions;
  readonly git?: ObserverRuntimeGitOptions;
  readonly onEvidence: (evidence: ObserverEvidence) => void;
  readonly onError?: (error: ObserverRuntimeError) => void;
}

export type ObserverRuntimeErrorSource =
  ObserverEvidenceSource | 'filesystem' | 'git' | 'process' | 'test_observer' | 'runtime';

export interface ObserverRuntimeError {
  readonly source: ObserverRuntimeErrorSource;
  readonly error: unknown;
  readonly message: string;
}

export interface ObserverCommandStart {
  readonly id: string;
  readonly commandName: string;
  readonly startedAt?: number;
}

export interface ObserverCommandFinish {
  readonly id: string;
  readonly exitCode: number;
  readonly endedAt?: number;
}

export class ObserverRuntime {
  private readonly sessionId: string;
  private readonly workspacePath: string;
  private readonly now: () => number;
  private readonly options: ObserverRuntimeOptions;
  private readonly ledger = new ObserverEvidenceLedger();
  private readonly testObserver: TestObserver;
  private readonly commandIds = new Set<string>();
  private processObserver: ProcessObserver | undefined;
  private fileObserver: FilesystemObserver | undefined;
  private gitObserver: GitObserver | undefined;
  private sequence = 0;
  private active = false;

  constructor(options: ObserverRuntimeOptions) {
    if (options.sessionId.length === 0) throw new RangeError('sessionId must not be empty.');
    this.sessionId = options.sessionId;
    this.workspacePath = options.workspacePath;
    this.now = options.now ?? Date.now;
    this.options = options;
    this.testObserver = new TestObserver({ now: this.now });
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.startProcessObserver();
    this.startFileObserver();
    this.gitObserver = new GitObserver(
      { rootPath: this.workspacePath, now: this.now },
      this.options.git?.run,
    );
    await this.captureGitBaseline();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.fileObserver?.stop();
    this.fileObserver = undefined;
    this.processObserver?.stop();
    this.processObserver = undefined;
    this.commandIds.clear();
  }

  notifyProcessExit(exitCode?: number, signal?: string, endedAt = this.now()): void {
    if (!this.active) return;
    try {
      this.processObserver?.notifyExit(exitCode, signal, endedAt);
    } catch (error) {
      this.reportError('process', error);
    }
  }

  async pollProcess(): Promise<ProcessInspection | undefined> {
    if (!this.active || this.processObserver === undefined) return undefined;
    try {
      return await this.processObserver.pollOnce();
    } catch (error) {
      this.reportError('process', error);
      return undefined;
    }
  }

  async captureGitSnapshot(): Promise<GitSnapshot | undefined> {
    if (!this.active || this.gitObserver === undefined) return undefined;
    try {
      const snapshot = await this.gitObserver.capture();
      this.emitGitSnapshot('snapshot', snapshot);
      return snapshot;
    } catch (error) {
      this.reportError('git', error);
      return undefined;
    }
  }

  async captureGitChanges(): Promise<GitChangeSet | undefined> {
    if (!this.active || this.gitObserver === undefined) return undefined;
    try {
      return await this.gitObserver.changesSinceBaseline();
    } catch (error) {
      this.reportError('git', error);
      return undefined;
    }
  }

  observeCommandStarted(input: ObserverCommandStart): TestObservation | undefined {
    if (!this.active || this.commandIds.has(input.id)) return undefined;
    try {
      const observation = this.testObserver.start(input.id, input.commandName, input.startedAt);
      this.commandIds.add(input.id);
      this.emitTestObservation('started', observation);
      return observation;
    } catch (error) {
      this.reportError('test_observer', error);
      return undefined;
    }
  }

  observeCommandFinished(input: ObserverCommandFinish): TestObservation | undefined {
    if (!this.active || !this.commandIds.has(input.id)) return undefined;
    try {
      const observation = this.testObserver.finish(input.id, input.exitCode, input.endedAt);
      this.commandIds.delete(input.id);
      if (observation !== undefined) this.emitTestObservation('finished', observation);
      return observation;
    } catch (error) {
      this.reportError('test_observer', error);
      return undefined;
    }
  }

  cancelCommand(id: string): TestObservation | undefined {
    if (!this.active || !this.commandIds.has(id)) return undefined;
    try {
      const observation = this.testObserver.cancel(id);
      this.commandIds.delete(id);
      if (observation !== undefined) this.emitTestObservation('finished', observation);
      return observation;
    } catch (error) {
      this.reportError('test_observer', error);
      return undefined;
    }
  }

  listEvidence(): readonly ObserverEvidence[] {
    return this.ledger.list();
  }

  get isActive(): boolean {
    return this.active;
  }

  private startProcessObserver(): void {
    const processOptions = this.options.process;
    if (processOptions === undefined) return;
    this.processObserver = new ProcessObserver({
      pid: processOptions.pid,
      now: this.now,
      ...(processOptions.pollMs === undefined ? {} : { pollMs: processOptions.pollMs }),
      ...(processOptions.inspect === undefined ? {} : { inspect: processOptions.inspect }),
      onObservation: (observation) => {
        if (this.active) this.emitProcessObservation(observation);
      },
    });
    try {
      this.processObserver.start(processOptions.startedAt ?? this.now());
    } catch (error) {
      this.reportError('process', error);
      this.processObserver = undefined;
    }
  }

  private startFileObserver(): void {
    const fileOptions = this.options.file;
    if (fileOptions === undefined) return;
    this.fileObserver = new FilesystemObserver(
      {
        rootPath: this.workspacePath,
        ...(fileOptions.debounceMs === undefined ? {} : { debounceMs: fileOptions.debounceMs }),
        onChange: (observation) => {
          if (this.active) this.emitFileObservation(observation);
        },
      },
      fileOptions.watchFactory,
    );
    try {
      this.fileObserver.start();
    } catch (error) {
      this.reportError('filesystem', error);
      this.fileObserver = undefined;
    }
  }

  private async captureGitBaseline(): Promise<void> {
    if (!this.active || this.gitObserver === undefined) return;
    try {
      const snapshot = await this.gitObserver.captureBaseline();
      if (this.active) this.emitGitSnapshot('baseline', snapshot);
    } catch (error) {
      this.reportError('git', error);
    }
  }

  private emitProcessObservation(observation: ProcessObservation): void {
    const phase = observation.kind === 'started' ? 'started' : 'finished';
    this.emitEvidence({
      key: `process:${observation.pid}:${phase}`,
      source: 'process',
      kind: 'lifecycle',
      confidence: observation.kind === 'started' ? 1 : 0.98,
      reason: `Process observer reported ${phase} for the wrapper root process.`,
      timestamp: observation.observedAt,
      payload: observation,
    });
  }

  private emitFileObservation(observation: FileObservation): void {
    this.emitEvidence({
      key: `file:${observation.path}`,
      source: 'filesystem',
      kind: 'file',
      confidence: 0.65,
      reason: 'Filesystem observer reported a workspace path change.',
      timestamp: observation.timestamp,
      payload: observation,
    });
  }

  private emitGitSnapshot(kind: 'baseline' | 'snapshot', snapshot: GitSnapshot): void {
    this.emitEvidence({
      key: `git:${snapshot.rootPath}:${kind}`,
      source: 'git',
      kind: 'workspace',
      confidence: snapshot.isRepository ? 0.8 : 0.3,
      reason: snapshot.isRepository
        ? `Git ${kind} snapshot captured for the workspace.`
        : `Git ${kind} unavailable: ${snapshot.reason ?? 'not a repository'}.`,
      timestamp: snapshot.capturedAt,
      payload: snapshot,
    });
  }

  private emitTestObservation(phase: 'started' | 'finished', observation: TestObservation): void {
    const kind: ObserverEvidenceKind = phase === 'started' ? 'command' : 'verification';
    const confidence = observation.kind === 'unknown' ? 0.2 : 0.9;
    this.emitEvidence({
      key: `command:${observation.id}:${phase}`,
      source: 'test_observer',
      kind,
      confidence,
      reason:
        phase === 'started'
          ? 'Known verification command started.'
          : `Known verification command finished with ${observation.outcome} outcome.`,
      timestamp: observation.endedAt ?? observation.startedAt,
      payload: observation,
    });
  }

  private emitEvidence(
    input: Omit<ObserverEvidence, 'id' | 'key'> & { readonly key: string },
  ): void {
    if (!this.active) return;
    const evidence: ObserverEvidence = {
      id: `${this.sessionId}:observer:${this.sequence++}`,
      ...input,
    };
    let result: ReturnType<ObserverEvidenceLedger['record']>;
    try {
      result = this.ledger.record(evidence);
    } catch (error) {
      this.reportError('runtime', error);
      return;
    }
    if (!result.accepted) return;
    try {
      this.options.onEvidence(result.selected);
    } catch (error) {
      this.reportError('runtime', error);
    }
  }

  private reportError(source: ObserverRuntimeErrorSource, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.options.onError?.({ source, error, message });
    } catch {
      // Error reporting must never become a second observer failure.
    }
  }
}
