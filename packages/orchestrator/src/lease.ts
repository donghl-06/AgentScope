import {
  StorageConflictError,
  type OrchestratorRepository,
  type StoredGoalRunLease,
} from '@agentscope/storage';

export interface LeaseClock {
  readonly now: () => number;
}

export interface GoalRunLeaseManagerOptions {
  readonly repository: OrchestratorRepository;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly clock?: LeaseClock;
}

export interface GoalRunLeaseHandle {
  readonly goalId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly expiresAt: number;
}

export class GoalRunLeaseManager {
  private readonly clock: LeaseClock;

  constructor(private readonly options: GoalRunLeaseManagerOptions) {
    if (options.ownerId.trim().length === 0) throw new Error('Lease owner must not be empty.');
    if (!Number.isInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new Error('Lease TTL must be a positive integer.');
    }
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  acquire(goalId: string): GoalRunLeaseHandle {
    const lease = this.options.repository.acquireGoalRunLease({
      goalId,
      ownerId: this.options.ownerId,
      ttlMs: this.options.ttlMs,
      now: this.clock.now(),
    });
    return toHandle(lease);
  }

  heartbeat(handle: GoalRunLeaseHandle): GoalRunLeaseHandle {
    assertHandleOwner(handle, this.options.ownerId);
    const lease = this.options.repository.renewGoalRunLease(
      handle.goalId,
      this.options.ownerId,
      handle.generation,
      this.options.ttlMs,
      this.clock.now(),
    );
    return toHandle(lease);
  }

  release(handle: GoalRunLeaseHandle): boolean {
    assertHandleOwner(handle, this.options.ownerId);
    return this.options.repository.releaseGoalRunLease(
      handle.goalId,
      this.options.ownerId,
      handle.generation,
      this.clock.now(),
    );
  }

  isHeld(handle: GoalRunLeaseHandle): boolean {
    assertHandleOwner(handle, this.options.ownerId);
    const lease = this.options.repository.getGoalRunLease(handle.goalId);
    return (
      lease !== undefined &&
      lease.ownerId === this.options.ownerId &&
      lease.generation === handle.generation &&
      lease.expiresAt > this.clock.now()
    );
  }

  assertHeld(handle: GoalRunLeaseHandle): void {
    if (!this.isHeld(handle)) {
      throw new StorageConflictError(`Goal ${handle.goalId} is no longer held by this run lease.`);
    }
  }
}

function toHandle(lease: StoredGoalRunLease): GoalRunLeaseHandle {
  return {
    goalId: lease.goalId,
    ownerId: lease.ownerId,
    generation: lease.generation,
    expiresAt: lease.expiresAt,
  };
}

function assertHandleOwner(handle: GoalRunLeaseHandle, ownerId: string): void {
  if (handle.ownerId !== ownerId) {
    throw new StorageConflictError(
      `Lease handle for Goal ${handle.goalId} belongs to another owner.`,
    );
  }
}
