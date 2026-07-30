import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    exclude: ['tests/e2e.spec.ts', 'tests/*.e2e.spec.ts', 'node_modules/**'],
    // D7 — Vitest only DEFAULTS NODE_ENV to 'test' when it is unset, so an
    // ambient `NODE_ENV=development` used to re-arm the local-config clobber
    // that destroyed the live projectsRoot. Pin it here, and pin an explicit
    // opt-out alongside it so the guard never rests on a single variable.
    // `src/projectLifecycle.ts` additionally refuses to touch the local config
    // whenever the Vitest worker's own VITEST* variables are present, which no
    // config change can remove.
    env: {
      NODE_ENV: 'test',
      PROJECTMANAGAIR_LOCAL_CONFIG_MODE: 'blocked',
    },
  },
});
