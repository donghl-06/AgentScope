import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export type FileChangeKind = 'create' | 'modify' | 'delete';

export interface FileObservation {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly timestamp: number;
}

export interface FilesystemObserverOptions {
  readonly rootPath: string;
  readonly ignore?: readonly string[];
  readonly respectGitignore?: boolean;
  readonly debounceMs?: number;
  readonly onChange: (observation: FileObservation) => void;
}

export interface FileWatchHandle {
  close(): void;
}

export type FileWatchFactory = (
  rootPath: string,
  onEvent: (kind: 'rename' | 'change', filename: string | Buffer | null) => void,
) => FileWatchHandle;

export const DEFAULT_FILE_IGNORES = [
  '.git',
  '.agentscope',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.turbo',
] as const;

export class FilesystemObserver {
  private readonly rootPath: string;
  private readonly ignored: readonly string[];
  private readonly gitignoreRules: readonly GitignoreRule[];
  private readonly debounceMs: number;
  private readonly onChange: FilesystemObserverOptions['onChange'];
  private readonly pending = new Map<string, FileChangeKind>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: FileWatchHandle | undefined;

  constructor(options: FilesystemObserverOptions, watchFactory: FileWatchFactory = defaultWatch) {
    this.rootPath = resolve(options.rootPath);
    this.ignored = [...DEFAULT_FILE_IGNORES, ...(options.ignore ?? [])];
    this.gitignoreRules =
      options.respectGitignore === false ? [] : readGitignoreRules(this.rootPath);
    this.debounceMs = validateDebounce(options.debounceMs ?? 120);
    this.onChange = options.onChange;
    this.watchFactory = watchFactory;
  }

  private readonly watchFactory: FileWatchFactory;

  start(): void {
    if (this.watcher !== undefined) return;
    if (!existsSync(this.rootPath)) throw new Error(`Workspace does not exist: ${this.rootPath}`);
    this.watcher = this.watchFactory(this.rootPath, (kind, filename) => {
      const path = normalizeObservedPath(this.rootPath, filename);
      if (
        path === undefined ||
        isIgnoredPath(path, this.ignored) ||
        isGitignoredPath(path, this.gitignoreRules)
      ) {
        return;
      }
      const fullPath = resolve(this.rootPath, path);
      const change = kind === 'rename' ? (existsSync(fullPath) ? 'create' : 'delete') : 'modify';
      this.enqueue(path, change);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private enqueue(path: string, kind: FileChangeKind): void {
    const previous = this.pending.get(path);
    this.pending.set(path, mergeChangeKinds(previous, kind));
    const existingTimer = this.timers.get(path);
    if (existingTimer !== undefined) clearTimeout(existingTimer);
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        const merged = this.pending.get(path);
        this.pending.delete(path);
        if (merged !== undefined) this.onChange({ path, kind: merged, timestamp: Date.now() });
      }, this.debounceMs),
    );
  }
}

export function normalizeObservedPath(
  rootPath: string,
  filename: string | Buffer | null,
): string | undefined {
  if (filename === null) return undefined;
  const value = filename.toString();
  if (value.length === 0 || isAbsolute(value)) return undefined;
  const resolved = resolve(rootPath, value);
  const relativePath = relative(resolve(rootPath), resolved);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${separator()}`)
  ) {
    return undefined;
  }
  return relativePath.split(separator()).join('/');
}

export function isIgnoredPath(
  path: string,
  ignored: readonly string[] = DEFAULT_FILE_IGNORES,
): boolean {
  const segments = path.split('/');
  return ignored.some((entry) => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (normalized.length === 0) return false;
    return (
      path === normalized || path.startsWith(`${normalized}/`) || segments.includes(normalized)
    );
  });
}

export interface GitignoreRule {
  readonly pattern: string;
  readonly negated: boolean;
}

export function parseGitignore(content: string): readonly GitignoreRule[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const pattern = (negated ? line.slice(1) : line).replace(/^\/+/, '');
      return { pattern, negated };
    })
    .filter((rule) => rule.pattern.length > 0);
}

export function isGitignoredPath(path: string, rules: readonly GitignoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesGitignorePattern(path, rule.pattern)) ignored = !rule.negated;
  }
  return ignored;
}

export function mergeChangeKinds(
  previous: FileChangeKind | undefined,
  next: FileChangeKind,
): FileChangeKind {
  if (previous === undefined || previous === next) return next;
  if (previous === 'delete' || next === 'delete') return 'delete';
  if (previous === 'create' || next === 'create') return 'create';
  return 'modify';
}

function validateDebounce(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('debounceMs must be non-negative.');
  return value;
}

function readGitignoreRules(rootPath: string): readonly GitignoreRule[] {
  const filename = resolve(rootPath, '.gitignore');
  if (!existsSync(filename)) return [];
  try {
    return parseGitignore(readFileSync(filename, 'utf8'));
  } catch {
    return [];
  }
}

function matchesGitignorePattern(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/$/u, '');
  if (normalized.length === 0) return false;
  const expression = globToRegExp(normalized, normalized.includes('/'));
  if (normalized.includes('/')) return expression.test(path);
  return path.split('/').some((segment) => expression.test(segment));
}

function globToRegExp(pattern: string, rooted: boolean): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else source += rooted ? '[^/]*' : '.*';
    } else if (character === '?') source += rooted ? '[^/]' : '.';
    else source += character === undefined ? '' : escapeRegExp(character);
  }
  return new RegExp(rooted ? `^${source}(?:/|$)` : `^${source}$`, 'u');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function defaultWatch(
  rootPath: string,
  onEvent: (kind: 'rename' | 'change', filename: string | Buffer | null) => void,
): FSWatcher {
  return watch(rootPath, { recursive: true }, (kind, filename) => onEvent(kind, filename));
}
