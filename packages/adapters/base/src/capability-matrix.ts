import type { AgentCapabilities } from './contract.js';

/**
 * Capability dimensions that are reviewed against a concrete worker version.
 * The first seven are the provider-neutral adapter capabilities; the remaining
 * dimensions describe control surfaces that are important to the Orchestrator
 * but are intentionally not collapsed into a boolean telemetry flag.
 */
export const WORKER_CAPABILITY_KEYS = [
  'structuredEvents',
  'sessionInfo',
  'tokenUsage',
  'toolCalls',
  'fileEvents',
  'commandEvents',
  'milestones',
  'permissionRequests',
  'interrupts',
  'tty',
  'resume',
] as const;

export type WorkerCapabilityKey = (typeof WORKER_CAPABILITY_KEYS)[number];

export const CAPABILITY_STATUSES = [
  'verified',
  'observed',
  'available',
  'conservative',
  'unavailable',
  'unsupported',
  'unknown',
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityObservation {
  readonly status: CapabilityStatus;
  /** Short, redacted evidence reference; never a prompt, token, or raw transcript. */
  readonly evidence: string;
  /** Explicit fallback when the native capability is absent or guarded. */
  readonly fallback?: string;
}

export interface WorkerCapabilityProfile {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly adapter: string;
  readonly cliVersion: string;
  readonly observedAt: string;
  readonly capabilities: Readonly<Record<WorkerCapabilityKey, CapabilityObservation>>;
}

export interface WorkerCapabilityMatrix {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly profiles: readonly WorkerCapabilityProfile[];
}

export class CapabilityMatrixValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityMatrixValidationError';
  }
}

/**
 * Parse a checked-in capability fixture without silently accepting new fields.
 * A new provider or capability dimension must therefore be reviewed explicitly
 * before it can influence safety or downgrade decisions.
 */
export function parseWorkerCapabilityMatrix(input: unknown): WorkerCapabilityMatrix {
  assertRecord(input, 'matrix');
  assertExactKeys(input, ['schemaVersion', 'generatedAt', 'profiles'], 'matrix');
  if (input.schemaVersion !== 1) {
    throw new CapabilityMatrixValidationError('Unsupported capability matrix schema version.');
  }
  const generatedAt = readNonEmptyString(input.generatedAt, 'matrix.generatedAt');
  if (!Array.isArray(input.profiles) || input.profiles.length === 0) {
    throw new CapabilityMatrixValidationError('matrix.profiles must be a non-empty array.');
  }
  const profiles = input.profiles.map((profile, index) => parseProfile(profile, index));
  const ids = new Set<string>();
  for (const profile of profiles) {
    const id = `${profile.provider}/${profile.adapter}/${profile.cliVersion}`;
    if (ids.has(id)) throw new CapabilityMatrixValidationError(`Duplicate profile: ${id}.`);
    ids.add(id);
  }
  return { schemaVersion: 1, generatedAt, profiles };
}

/**
 * Project only the seven provider-neutral telemetry capabilities. Control
 * dimensions such as approval and interrupt remain available to policy code,
 * rather than being mistaken for emitted event support.
 */
export function projectAdapterCapabilities(profile: WorkerCapabilityProfile): AgentCapabilities {
  return {
    structuredEvents: isNative(profile.capabilities.structuredEvents),
    toolCalls: isNative(profile.capabilities.toolCalls),
    fileEvents: isNative(profile.capabilities.fileEvents),
    commandEvents: isNative(profile.capabilities.commandEvents),
    tokenUsage: isNative(profile.capabilities.tokenUsage),
    sessionInfo: isNative(profile.capabilities.sessionInfo),
    milestones: isNative(profile.capabilities.milestones),
  };
}

export function findWorkerCapabilityProfile(
  matrix: WorkerCapabilityMatrix,
  input: { readonly provider: string; readonly adapter: string; readonly cliVersion: string },
): WorkerCapabilityProfile | undefined {
  return matrix.profiles.find(
    (profile) =>
      profile.provider === input.provider &&
      profile.adapter === input.adapter &&
      profile.cliVersion === input.cliVersion,
  );
}

function parseProfile(input: unknown, index: number): WorkerCapabilityProfile {
  assertRecord(input, `matrix.profiles[${index}]`);
  assertExactKeys(
    input,
    ['schemaVersion', 'provider', 'adapter', 'cliVersion', 'observedAt', 'capabilities'],
    `matrix.profiles[${index}]`,
  );
  if (input.schemaVersion !== 1) {
    throw new CapabilityMatrixValidationError(`matrix.profiles[${index}].schemaVersion must be 1.`);
  }
  const capabilitiesInput = input.capabilities;
  assertRecord(capabilitiesInput, `matrix.profiles[${index}].capabilities`);
  assertExactKeys(capabilitiesInput, WORKER_CAPABILITY_KEYS, 'capability profile');
  const capabilities = Object.fromEntries(
    WORKER_CAPABILITY_KEYS.map((key) => [
      key,
      parseObservation(capabilitiesInput[key], `matrix.profiles[${index}].capabilities.${key}`),
    ]),
  ) as Record<WorkerCapabilityKey, CapabilityObservation>;
  return {
    schemaVersion: 1,
    provider: readNonEmptyString(input.provider, `matrix.profiles[${index}].provider`),
    adapter: readNonEmptyString(input.adapter, `matrix.profiles[${index}].adapter`),
    cliVersion: readNonEmptyString(input.cliVersion, `matrix.profiles[${index}].cliVersion`),
    observedAt: readNonEmptyString(input.observedAt, `matrix.profiles[${index}].observedAt`),
    capabilities,
  };
}

function parseObservation(input: unknown, path: string): CapabilityObservation {
  assertRecord(input, path);
  assertExactKeys(input, ['status', 'evidence', 'fallback'], path, ['fallback']);
  if (!CAPABILITY_STATUSES.includes(input.status as CapabilityStatus)) {
    throw new CapabilityMatrixValidationError(`${path}.status is not a known capability status.`);
  }
  const evidence = readNonEmptyString(input.evidence, `${path}.evidence`);
  const fallback =
    input.fallback === undefined
      ? undefined
      : readNonEmptyString(input.fallback, `${path}.fallback`);
  return {
    status: input.status as CapabilityStatus,
    evidence,
    ...(fallback === undefined ? {} : { fallback }),
  };
}

function isNative(observation: CapabilityObservation): boolean {
  return (
    observation.status === 'verified' ||
    observation.status === 'observed' ||
    observation.status === 'available'
  );
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CapabilityMatrixValidationError(`${path} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const expected = new Set(keys);
  const optionalKeys = new Set(optional);
  const actual = Object.keys(value);
  const missing = keys.filter(
    (key) => !optionalKeys.has(key) && !Object.prototype.hasOwnProperty.call(value, key),
  );
  const unknown = actual.filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new CapabilityMatrixValidationError(
      `${path} keys mismatch (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}).`,
    );
  }
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CapabilityMatrixValidationError(`${path} must be a non-empty string.`);
  }
  return value;
}
