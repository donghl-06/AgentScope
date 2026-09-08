#!/usr/bin/env node
/* global clearTimeout, performance, setTimeout */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? 8791);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Usage: event-latency-smoke.mjs [port]');
}

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cli = path.join(repoRoot, 'apps', 'cli', 'bin', 'agent-scope.mjs');
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentscope-event-latency-'));
const database = path.join(directory, 'events.db');
const serverUrl = `http://127.0.0.1:${port}`;
const socketUrl = `ws://127.0.0.1:${port}/ws`;
let server;
let socket;

try {
  server = spawn(
    process.execPath,
    [
      cli,
      'start',
      '--no-dashboard',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--database',
      database,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENTSCOPE_DATABASE: database },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  await waitForHealth(serverUrl, server);
  socket = await openSocket(socketUrl);
  const received = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'event.appended' && typeof message.seq === 'number') {
      received.push({ seq: message.seq, receivedAt: performance.now() });
    }
  });

  const mock = await runMock(database);
  // The server uses a bounded external-database poll interval; allow the final
  // notification to arrive before comparing the authoritative HTTP snapshot.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const eventsResponse = await fetch(
    `${serverUrl}/api/sessions/${encodeURIComponent(mock.sessionId)}/events?after=0&limit=100`,
  );
  const eventsPage = await eventsResponse.json();
  const receivedAtBySeq = new Map(received.map((item) => [item.seq, item.receivedAt]));
  const wallAtPerformanceStart = Date.now() - performance.now();
  const latencies = Array.isArray(eventsPage.items)
    ? eventsPage.items.flatMap((item) => {
        const receivedAt = receivedAtBySeq.get(item.seq);
        const timestamp = item.event?.timestamp;
        if (receivedAt === undefined || typeof timestamp !== 'number') return [];
        return [Math.max(0, Math.round(wallAtPerformanceStart + receivedAt - timestamp))];
      })
    : [];

  process.stdout.write(
    JSON.stringify(
      {
        server: serverUrl,
        sessionId: mock.sessionId,
        eventCount: Array.isArray(eventsPage.items) ? eventsPage.items.length : 0,
        notificationsReceived: received.length,
        samples: latencies.length,
        missingNotifications: Math.max(
          0,
          (Array.isArray(eventsPage.items) ? eventsPage.items.length : 0) - latencies.length,
        ),
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          max: latencies.length === 0 ? 0 : Math.max(...latencies),
        },
        note: 'Measures event timestamp to WebSocket receipt; it is not browser paint latency.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  socket?.terminate();
  if (server?.pid !== undefined) {
    await terminateProcessTree(server.pid);
    if (server.exitCode === null) {
      try {
        server.kill();
      } catch {
        // The process may have exited between taskkill and this fallback.
      }
    }
    await waitForChildExit(server);
  }
  await removeTemporaryDirectory(directory);
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // The server may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the AgentScope server.');
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    const onError = (error) => reject(error);
    client.once('error', onError);
    client.once('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'hello') return;
      client.removeListener('error', onError);
      resolve(client);
    });
  });
}

function runMock(databaseFilename) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', 'mock', '--fixture', 'basic-success'], {
      cwd: repoRoot,
      env: { ...process.env, AGENTSCOPE_DATABASE: databaseFilename },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Mock smoke failed: ${stderr.trim()}`));
        return;
      }
      resolve(JSON.parse(stdout.trim()));
    });
  });
}

function terminateProcessTree(pid) {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGTERM');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}
