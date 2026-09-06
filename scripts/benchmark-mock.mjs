#!/usr/bin/env node
/* global performance, setTimeout */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(repoRoot, 'apps', 'cli', 'bin', 'agent-scope.mjs');
const argumentsList = process.argv.slice(2);
const iterationsIndex = argumentsList.indexOf('--iterations');
const iterations = iterationsIndex === -1 ? 1 : parseIterations(argumentsList[iterationsIndex + 1]);
const fixtures = argumentsList.filter(
  (argument, index) => argument !== '--iterations' && index !== iterationsIndex + 1,
);
const selectedFixtures =
  fixtures.length > 0
    ? fixtures
    : ['basic-success', 'test-failure', 'blocked-then-resumed', 'low-signal'];

const directory = await mkdtemp(path.join(os.tmpdir(), 'agentscope-benchmark-'));
const database = path.join(directory, 'benchmark.db');
const startedAt = performance.now();
const cpuStarted = process.cpuUsage();
let peakRssBytes = process.memoryUsage().rss;
const rssSampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 25);

try {
  await prepareDatabase();
  // Windows can release the previous SQLite handle just after the child exits.
  // Give the handle a short grace period before measuring concurrent writers.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const workloads = Array.from({ length: iterations }, (_, iteration) =>
    selectedFixtures.map((fixture) => ({ fixture, iteration: iteration + 1 })),
  ).flat();
  const results = await Promise.all(
    workloads.map(({ fixture, iteration }) => runFixture(fixture, iteration)),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const cpu = process.cpuUsage(cpuStarted);
  const wrapperLatencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const databaseBytes = (await stat(database)).size;
  process.stdout.write(
    `${JSON.stringify(
      {
        fixtures: results,
        iterations,
        elapsedMs,
        databaseBytes,
        wrapperLatencyMs: {
          p50: percentile(wrapperLatencies, 0.5),
          p95: percentile(wrapperLatencies, 0.95),
          samples: wrapperLatencies.length,
        },
        orchestratorCpuMs: {
          user: Math.round(cpu.user / 1_000),
          system: Math.round(cpu.system / 1_000),
        },
        orchestratorPeakRssBytes: peakRssBytes,
        node: process.version,
        platform: process.platform + '-' + process.arch,
        note: 'Wrapper latency and orchestrator resource baseline only; not a UI latency or supported capacity limit.',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  clearInterval(rssSampler);
  await removeTemporaryDirectory(directory);
}

function parseIterations(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('--iterations must be an integer between 1 and 100.');
  }
  return parsed;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1);
  return values[index];
}

function prepareDatabase() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'recover'], {
      cwd: directory,
      env: { ...process.env, AGENTSCOPE_DATABASE: database },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`Could not initialize benchmark database. ${stderr.trim()}`));
    });
  });
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function runFixture(fixture, iteration) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', 'mock', '--fixture', fixture], {
      cwd: directory,
      env: { ...process.env, AGENTSCOPE_DATABASE: database },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const fixtureStartedAt = performance.now();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      const output = parseLastJson(stdout);
      if (output === undefined) {
        reject(new Error(`Mock fixture ${fixture} returned no JSON. ${stderr.trim()}`));
        return;
      }
      resolve({
        fixture,
        iteration,
        exitCode,
        signal,
        status: output.status,
        eventCount: output.eventCount,
        elapsedMs: Math.round(performance.now() - fixtureStartedAt),
      });
    });
  });
}

function parseLastJson(output) {
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end < start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}
