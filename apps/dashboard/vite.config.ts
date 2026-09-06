import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export function resolveApiProxyTargets(env: NodeJS.ProcessEnv = process.env): {
  readonly http: string;
  readonly websocket: string;
} {
  const http =
    env.VITE_API_BASE_URL ??
    env.AGENTSCOPE_SERVER_URL ??
    `http://127.0.0.1:${env.AGENTSCOPE_PORT ?? '8787'}`;
  return {
    http,
    websocket: http.replace(/^http:/u, 'ws:').replace(/^https:/u, 'wss:'),
  };
}

const apiProxyTargets = resolveApiProxyTargets();

export default defineConfig({
  plugins: [react()],
  cacheDir: '../../.vite/dashboard',
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxyTargets.http,
      '/ws': {
        target: apiProxyTargets.websocket,
        ws: true,
      },
    },
  },
});
