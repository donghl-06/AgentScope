#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? 8790);
const database = process.argv[3];
if (!Number.isInteger(port) || database === undefined) {
  throw new Error('Usage: ws-reconnect-smoke.mjs <port> <database>');
}

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cli = path.join(repoRoot, 'apps', 'cli', 'bin', 'agent-scope.mjs');
const url = 'ws://127.0.0.1:' + port + '/ws';

const firstConnection = await openSocket(url);
firstConnection.socket.close();
const mock = await runMock(cli, repoRoot, database);
const secondConnection = await openSocket(url);
secondConnection.socket.close();
const response = await fetch(
  'http://127.0.0.1:' +
    port +
    '/api/sessions/' +
    encodeURIComponent(mock.sessionId) +
    '/events?after=0&limit=100',
);
const catchup = await response.json();

process.stdout.write(
  JSON.stringify(
    {
      firstConnection: firstConnection.messages,
      secondConnection: secondConnection.messages,
      mock: {
        sessionId: mock.sessionId,
        status: mock.status,
        exitCode: mock.exitCode,
        eventCount: mock.eventCount,
      },
      catchup: {
        status: response.status,
        eventCount: Array.isArray(catchup.items) ? catchup.items.length : 0,
        firstSeq: catchup.items?.[0]?.seq ?? null,
        lastSeq: catchup.items?.at(-1)?.seq ?? null,
      },
    },
    null,
    2,
  ) + '\n',
);

function openSocket(socketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const messages = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message.type);
      if (message.type === 'hello') resolve({ socket, messages });
    });
    socket.on('error', reject);
  });
}

function runMock(command, cwd, filename) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, 'run', 'mock', '--fixture', 'basic-success'], {
      cwd,
      env: { ...process.env, AGENTSCOPE_DATABASE: filename },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const parsed = JSON.parse(stdout.trim());
      if (exitCode !== 0) {
        reject(new Error('Mock smoke failed: ' + stderr.trim()));
        return;
      }
      resolve(parsed);
    });
  });
}
