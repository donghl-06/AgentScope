import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CapabilityMatrixValidationError,
  findWorkerCapabilityProfile,
  parseWorkerCapabilityMatrix,
  projectAdapterCapabilities,
} from './capability-matrix.js';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/capabilities/worker-capability-matrix-v1.json',
);

describe('worker capability matrix', () => {
  it('parses the versioned, redacted worker profiles and projects telemetry flags', () => {
    const matrix = parseWorkerCapabilityMatrix(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.profiles.length).toBeGreaterThanOrEqual(5);
    const claude = findWorkerCapabilityProfile(matrix, {
      provider: 'claude',
      adapter: 'claude-code',
      cliVersion: '2.1.263',
    });
    expect(claude).toBeDefined();
    expect(projectAdapterCapabilities(claude!)).toEqual({
      structuredEvents: true,
      toolCalls: true,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: true,
      sessionInfo: true,
      milestones: true,
    });
    const tty = findWorkerCapabilityProfile(matrix, {
      provider: 'claude',
      adapter: 'claude-code-tty',
      cliVersion: '2.1.263',
    });
    expect(projectAdapterCapabilities(tty!)).toEqual({
      structuredEvents: false,
      toolCalls: false,
      fileEvents: true,
      commandEvents: false,
      tokenUsage: false,
      sessionInfo: true,
      milestones: false,
    });
  });

  it('rejects missing and newly introduced fields instead of silently guessing', () => {
    const source = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const missing = structuredClone(source) as { profiles: Array<Record<string, unknown>> };
    const first = missing.profiles[0];
    if (first === undefined) throw new Error('fixture is empty');
    const capabilities = first.capabilities as Record<string, unknown>;
    delete capabilities.interrupts;
    expect(() => parseWorkerCapabilityMatrix(missing)).toThrow(CapabilityMatrixValidationError);

    const added = structuredClone(source) as { profiles: Array<Record<string, unknown>> };
    const addedFirst = added.profiles[0];
    if (addedFirst === undefined) throw new Error('fixture is empty');
    (addedFirst.capabilities as Record<string, unknown>).futureSignal = {
      status: 'unknown',
      evidence: 'not reviewed',
    };
    expect(() => parseWorkerCapabilityMatrix(added)).toThrow(CapabilityMatrixValidationError);
  });

  it('keeps profile identity version-specific', () => {
    const matrix = parseWorkerCapabilityMatrix(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    expect(
      findWorkerCapabilityProfile(matrix, {
        provider: 'codex',
        adapter: 'codex-cli',
        cliVersion: '0.999.0',
      }),
    ).toBeUndefined();
  });
});
