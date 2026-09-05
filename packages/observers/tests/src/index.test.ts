import { describe, expect, it } from 'vitest';

import { TestObserver, classifyVerificationCommand } from './index.js';

describe('test observer', () => {
  it('classifies only known verification command patterns', () => {
    expect(classifyVerificationCommand('pnpm test')).toMatchObject({
      kind: 'test',
      confidence: 0.9,
    });
    expect(classifyVerificationCommand('pnpm run typecheck')).toMatchObject({ kind: 'typecheck' });
    expect(classifyVerificationCommand('npm run build')).toMatchObject({ kind: 'build' });
    expect(classifyVerificationCommand('eslint packages')).toMatchObject({ kind: 'lint' });
    expect(classifyVerificationCommand('custom script --check')).toMatchObject({
      kind: 'unknown',
      confidence: 0.2,
    });
  });

  it('maps known command exit outcomes and preserves duration', () => {
    const observer = new TestObserver({ now: () => 100 });
    observer.start('test-1', 'pnpm test', 10);
    expect(observer.finish('test-1', 0, 150)).toMatchObject({
      kind: 'test',
      outcome: 'passed',
      verification: 'passed',
      durationMs: 140,
    });
    observer.start('test-2', 'pnpm test', 200);
    expect(observer.finish('test-2', 130, 240)).toMatchObject({
      outcome: 'interrupted',
      verification: 'failed',
    });
  });

  it('keeps unknown commands generic and handles missing/cancelled commands', () => {
    const observer = new TestObserver({ now: () => 100 });
    observer.start('unknown', 'custom --check', 20);
    expect(observer.finish('unknown', 0, 30)).toMatchObject({
      kind: 'unknown',
      outcome: 'passed',
      verification: 'unknown',
    });
    expect(observer.finish('missing', 0)).toBeUndefined();
    observer.start('cancelled', 'pnpm test', 30);
    expect(observer.cancel('cancelled')).toMatchObject({ outcome: 'interrupted' });
  });
});
