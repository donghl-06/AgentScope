/**
 * Redaction at persistence boundaries. This removes credential-shaped values
 * while preserving ordinary task prose and numeric telemetry. It is deliberately
 * deterministic so tests and audit records can rely on the same representation.
 */
export const REDACTED_VALUE = '[REDACTED]';

const SECRET_KEY =
  /(?:api[_-]?key|authorization|cookie|password|secret|credential|access[_-]?token|refresh[_-]?token|private[_-]?key|env(?:ironment)?(?:[_-]|$))/iu;
const TOKEN_KEY = /(?:^|[_-])token(?:$|[_-])/iu;
const USAGE_KEY =
  /(?:^|[_-])(?:input|output|total|cached|reasoning|thinking|estimated|cache)[_-]?tokens?$/iu;
const PROVIDER_KEY = /\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const KEY_VALUE =
  /((?:api[_-]?key|auth(?:orization)?|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*)(["']?)(?!Bearer\b)[^\s,;&"']+\2/giu;
const URL_QUERY_SECRET = /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/giu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;

export function redactSecretText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, REDACTED_VALUE)
    .replace(PROVIDER_KEY, REDACTED_VALUE)
    .replace(BEARER_VALUE, 'Bearer ' + REDACTED_VALUE)
    .replace(KEY_VALUE, '$1$2' + REDACTED_VALUE + '$2')
    .replace(URL_QUERY_SECRET, '$1' + REDACTED_VALUE);
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactSensitiveValue(nestedValue);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  if (USAGE_KEY.test(key)) return false;
  return SECRET_KEY.test(key) || TOKEN_KEY.test(key);
}
