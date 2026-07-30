import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    exclude: ['tests/e2e.spec.ts', 'tests/*.e2e.spec.ts', 'node_modules/**'],
  },
});
