import { describe, expect, it } from 'vitest';

import { REDACTED_VALUE, redactSecretText, redactSensitiveValue } from './redaction.js';

describe('storage redaction', () => {
  it('redacts common provider credentials while preserving telemetry', () => {
    const value = {
      apiKey: 'sk-test-1234567890123456',
      authorization: 'Bearer top-secret-token',
      input_tokens: 42,
      output_tokens: 7,
      message: 'Call https://example.test/run?api_key=inline-secret&mode=safe',
      nested: { password: 'pässwörd-秘密', ordinary: 'keep this note' },
    };

    const redacted = redactSensitiveValue(value) as typeof value;

    expect(redacted.apiKey).toBe(REDACTED_VALUE);
    expect(redacted.authorization).toBe(REDACTED_VALUE);
    expect(redacted.input_tokens).toBe(42);
    expect(redacted.output_tokens).toBe(7);
    expect(redacted.message).not.toContain('inline-secret');
    expect(redacted.nested.password).toBe(REDACTED_VALUE);
    expect(redacted.nested.ordinary).toBe('keep this note');
  });

  it('handles text credentials in quoted, bearer, URL, and private-key forms', () => {
    const text = [
      'token="quoted-secret"',
      "access_token='single-quoted-secret'",
      'Authorization: Bearer abc.def-ghi_123',
      'https://example.test/?secret=query-secret&next=1',
      '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----',
      'provider key sk-kimi-1234567890123456',
    ].join('\n');

    const redacted = redactSecretText(text);

    expect(redacted).not.toContain('quoted-secret');
    expect(redacted).not.toContain('single-quoted-secret');
    expect(redacted).not.toContain('abc.def-ghi_123');
    expect(redacted).not.toContain('query-secret');
    expect(redacted).not.toContain('secret-material');
    expect(redacted).not.toContain('sk-kimi-1234567890123456');
    expect(redacted).toContain(REDACTED_VALUE);
  });

  it('does not erase ordinary prose or numeric token usage', () => {
    expect(redactSecretText('token budget and token usage are documented')).toBe(
      'token budget and token usage are documented',
    );
    expect(
      redactSensitiveValue({
        tokenUsage: { total_tokens: 49 },
        cache: { read_tokens: 12 },
        note: 'A secret is not present here.',
      }),
    ).toEqual({
      tokenUsage: { total_tokens: 49 },
      cache: { read_tokens: 12 },
      note: 'A secret is not present here.',
    });
  });

  it('redacts arrays and nested objects without mutating the input', () => {
    const input = [{ secret: 'do-not-store' }, 'apiKey=inline-secret', 3];
    const redacted = redactSensitiveValue(input);

    expect(redacted).toEqual([{ secret: REDACTED_VALUE }, `apiKey=${REDACTED_VALUE}`, 3]);
    expect(input).toEqual([{ secret: 'do-not-store' }, 'apiKey=inline-secret', 3]);
  });
});
