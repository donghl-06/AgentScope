#!/usr/bin/env node
/* global URL, console, process */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const loader = pathToFileURL(fileURLToPath(new URL('./ts-loader.mjs', import.meta.url))).href;
const result = spawnSync(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    '--experimental-transform-types',
    '--experimental-loader',
    loader,
    main,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

if (result.error !== undefined) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
