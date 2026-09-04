/** Sources are merged from lowest to highest precedence, left to right. */
export interface ConfigSources<T extends object> {
  readonly defaults: T;
  readonly file?: Partial<T>;
  readonly env?: Partial<T>;
  readonly cli?: Partial<T>;
}

/**
 * Merge top-level configuration values using CLI > environment > file > defaults.
 * Nested configuration is intentionally not deep-merged until a concrete schema exists.
 */
export function mergeConfig<T extends object>(sources: ConfigSources<T>): Readonly<T> {
  return Object.freeze({
    ...sources.defaults,
    ...sources.file,
    ...sources.env,
    ...sources.cli,
  });
}
