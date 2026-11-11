import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', rewrite: (p) => p.replace(/^\/api/, '') }, '/bundler': { target: 'http://127.0.0.1:4337', rewrite: (p) => p.replace(/^\/bundler/, '') }, '/rpc': { target: process.env.WALLET_RPC_URL ?? 'http://127.0.0.1:9545', changeOrigin: true, rewrite: (p) => p.replace(/^\/rpc/, '') } } },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
});
