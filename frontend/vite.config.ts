import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '');
  const appPort = env.APP_PORT || '8080';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://localhost:${appPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: '../backend/static',
      emptyOutDir: true,
    },
  };
});
