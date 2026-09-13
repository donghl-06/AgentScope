import type { WorkingSet, WorkingSetEviction } from './index.js';

export const WORKING_SET_MAX_FILES = 50;
export const WORKING_SET_MAX_DIRECTORIES = 20;
export const WORKING_SET_MAX_PATH_BUDGET = 16_000;
export const WORKING_SET_MAX_EVICTIONS = 100;

export interface MaintainWorkingSetInput {
  readonly current: WorkingSet;
  readonly candidates?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly failureFiles?: readonly string[];
  readonly directories?: readonly string[];
  readonly goalPrompt?: string;
  readonly updatedAt: number;
}

/**
 * Keep the Planner/Worker context bounded while making changed and failure
 * paths win over ordinary keyword matches. Sensitive paths are never added,
 * even when a Worker or a persisted Goal proposes them.
 */
export function maintainWorkingSet(input: MaintainWorkingSetInput): WorkingSet {
  const changedFiles = normalizePathSet(input.changedFiles ?? []);
  const failureFiles = normalizePathSet(input.failureFiles ?? []);
  const candidates = new Set<string>();
  const evictions: WorkingSetEviction[] = [...(input.current.evictions ?? [])];
  for (const value of [
    ...input.current.files,
    ...(input.candidates ?? []),
    ...changedFiles,
    ...failureFiles,
  ]) {
    const normalized = normalizePath(value);
    if (normalized.length === 0) continue;
    if (isSensitivePath(normalized)) {
      addEviction(evictions, {
        path: normalized,
        reason: 'sensitive-path',
        recordedAt: input.updatedAt,
      });
      continue;
    }
    candidates.add(normalized);
  }
  const goalTokens = tokenize(input.goalPrompt ?? '');
  const currentFiles = new Set(input.current.files.map(normalizePath));
  const scored = [...candidates].map((file) => ({
    file,
    score:
      (changedFiles.has(file) ? 10_000 : 0) +
      (failureFiles.has(file) ? 9_000 : 0) +
      (currentFiles.has(file) ? 100 : 0) +
      scorePath(file, goalTokens),
  }));
  scored.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  const selected: string[] = [];
  let pathBudget = 0;
  for (const candidate of scored) {
    if (selected.length >= WORKING_SET_MAX_FILES) {
      addEviction(evictions, {
        path: candidate.file,
        reason: 'file-capacity',
        recordedAt: input.updatedAt,
      });
      continue;
    }
    const nextBudget = pathBudget + candidate.file.length;
    if (nextBudget > WORKING_SET_MAX_PATH_BUDGET) {
      addEviction(evictions, {
        path: candidate.file,
        reason: 'path-budget',
        recordedAt: input.updatedAt,
      });
      continue;
    }
    selected.push(candidate.file);
    pathBudget = nextBudget;
  }
  selected.sort((left, right) => left.localeCompare(right));

  const directoryCandidates = new Set<string>();
  for (const value of [...input.current.directories, ...(input.directories ?? [])]) {
    const normalized = normalizePath(value);
    if (normalized.length === 0 || isSensitivePath(normalized)) continue;
    directoryCandidates.add(normalized);
  }
  const directories = [...directoryCandidates].sort((left, right) => left.localeCompare(right));
  const boundedDirectories = directories.slice(0, WORKING_SET_MAX_DIRECTORIES);
  for (const directory of directories.slice(WORKING_SET_MAX_DIRECTORIES)) {
    addEviction(evictions, {
      path: directory,
      reason: 'file-capacity',
      recordedAt: input.updatedAt,
    });
  }
  const omitted = evictions.length - (input.current.evictions?.length ?? 0);
  const rationale =
    omitted > 0
      ? `Bounded Working Set selected ${selected.length} file(s) and omitted ${omitted} candidate(s); changed and failure paths were prioritised.`
      : input.current.rationale;
  return {
    files: selected,
    directories: boundedDirectories,
    rationale: rationale.length > 1_000 ? `${rationale.slice(0, 997)}...` : rationale,
    updatedAt: input.updatedAt,
    ...(input.current.appliedInstructions === undefined
      ? {}
      : { appliedInstructions: input.current.appliedInstructions }),
    ...(evictions.length === 0 ? {} : { evictions: evictions.slice(-WORKING_SET_MAX_EVICTIONS) }),
  };
}

function normalizePathSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalizePath).filter((value) => value.length > 0));
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isSensitivePath(file: string): boolean {
  return (
    /(^|\/)(?:\.env(?:\.|$)|.*(?:secret|token|credential|key).*)/iu.test(file) ||
    file
      .split('/')
      .some((segment) =>
        new Set(['.git', '.agentscope', 'node_modules', 'dist', 'build', 'coverage']).has(segment),
      )
  );
}

function tokenize(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/giu) ?? [])];
}

function scorePath(file: string, tokens: readonly string[]): number {
  const normalized = file.toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 20 : 0), 0);
}

function addEviction(evictions: WorkingSetEviction[], eviction: WorkingSetEviction): void {
  if (
    evictions.some(
      (existing) => existing.path === eviction.path && existing.reason === eviction.reason,
    )
  ) {
    return;
  }
  evictions.push(eviction);
}
