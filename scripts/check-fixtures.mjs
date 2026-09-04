import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fixturesRoot = join(repositoryRoot, 'tests', 'fixtures', 'raw');
const forbiddenPatterns = [
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /ANTHROPIC_API_KEY\s*[:=]\s*[^<\s]+/i,
  /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)/,
  /"prompt"\s*:/i,
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files;
}

const files = await collectFiles(fixturesRoot);
const violations = [];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) {
      violations.push(`${relative(repositoryRoot, file)} matches ${pattern}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Fixture sensitivity check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Fixture sensitivity check passed (${files.length} JSONL files).`);
}
