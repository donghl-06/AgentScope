import { describe, expect, it } from 'vitest';

import { resolveApiProxyTargets } from '../vite.config.js';

describe('dashboard Vite API proxy targets', () => {
  it('follows the AgentScope server port inherited by the one-command launcher', () => {
    expect(resolveApiProxyTargets({ AGENTSCOPE_PORT: '8792' })).toEqual({
      http: 'http://127.0.0.1:8792',
      websocket: 'ws://127.0.0.1:8792',
    });
  });

  it('prefers an explicit server URL over the default port', () => {
    expect(
      resolveApiProxyTargets({
        AGENTSCOPE_PORT: '8792',
        AGENTSCOPE_SERVER_URL: 'http://127.0.0.1:9010',
      }),
    ).toEqual({
      http: 'http://127.0.0.1:9010',
      websocket: 'ws://127.0.0.1:9010',
    });
  });
});
