import type {
  TerminalDimensions,
  TerminalDriver,
  TerminalExit,
  TerminalProcess,
  TerminalState,
  TerminalSpawnSpec,
} from './types.js';

type DataListener = (data: string) => void;
type ExitListener = (event: TerminalExit) => void;

export class TerminalSession {
  readonly pid: number;
  private currentState: TerminalState = 'running';
  private killRequested = false;
  private exitEvent: TerminalExit | undefined;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  private constructor(private readonly process: TerminalProcess) {
    this.pid = process.pid;
    this.subscriptions.push(
      process.onData(data => {
        for (const listener of this.dataListeners) listener(data);
      }),
      process.onExit(event => this.handleExit(event)),
    );
  }

  static spawn(driver: TerminalDriver, spec: TerminalSpawnSpec): TerminalSession {
    return new TerminalSession(driver.spawn(spec));
  }

  get state(): TerminalState {
    return this.currentState;
  }

  get exit(): TerminalExit | undefined {
    return this.exitEvent;
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    this.assertRunning('write');
    this.process.write(data);
  }

  resize(dimensions: TerminalDimensions): void {
    this.assertRunning('resize');
    this.process.resize(dimensions.cols, dimensions.rows);
  }

  interrupt(): void {
    this.assertRunning('interrupt');
    this.process.write(String.fromCharCode(3));
  }

  kill(): void {
    this.requestDispose();
  }

  dispose(): void {
    this.requestDispose();
  }

  private requestDispose(): void {
    if (this.currentState === 'exited' || this.currentState === 'disposed') return;
    if (this.currentState === 'disposing' || this.killRequested) return;

    this.currentState = 'disposing';
    this.killRequested = true;
    try {
      this.process.kill();
    } catch {
      // A concurrent child exit is already a terminal condition. The onExit
      // callback, when available, will complete the transition to disposed.
      this.currentState = 'disposed';
      this.disposeSubscriptions();
    }
  }

  private handleExit(event: TerminalExit): void {
    if (this.exitEvent !== undefined) return;
    this.exitEvent = event;
    this.currentState = this.currentState === 'disposing' ? 'disposed' : 'exited';
    for (const listener of this.exitListeners) listener(event);
    this.disposeSubscriptions();
  }

  private disposeSubscriptions(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private assertRunning(action: string): void {
    if (this.currentState !== 'running') {
      throw new Error(`Cannot ${action} a terminal in state ${this.currentState}`);
    }
  }
}
