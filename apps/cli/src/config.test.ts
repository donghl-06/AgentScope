import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { DEFAULT_DATABASE, DEFAULT_HOST, DEFAULT_PORT, resolveCliConfig } from './config.js';

describe('CLI configuration', () => {
  it('uses loopback, a dedicated server port, and a project-local database by default', () => {
    const config = resolveCliConfig({ cwd: 'C:/workspace', env: {} });
    expect(config).toMatchObject({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      database: path.resolve('C:/workspace', DEFAULT_DATABASE),
      serverUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
      workspacePath: 'C:/workspace',
    });
    expect(DEFAULT_DATABASE).toBe('.agentscope/agentscope.db');
  });

  it('applies environment values and explicit values with the documented precedence', () => {
    const config = resolveCliConfig({
      cwd: 'C:/workspace',
      env: {
        AGENTSCOPE_HOST: '0.0.0.0',
        AGENTSCOPE_PORT: '9000',
        AGENTSCOPE_DATABASE: 'env.db',
        AGENTSCOPE_SERVER_URL: 'http://localhost:9000',
      },
      host: '127.0.0.1',
      port: 9100,
      database: 'cli.db',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 9100,
      database: path.resolve('C:/workspace', 'cli.db'),
      serverUrl: 'http://localhost:9000',
    });
  });
});
