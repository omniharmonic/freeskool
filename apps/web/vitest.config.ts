import { defineConfig } from 'vitest/config';

// Deliberately standalone (no Vite plugins, no `extends`): a stray
// vite.config.ts lives in the home directory, so config discovery must never
// walk up past this package.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['src/**/*.test.ts?(x)'],
    environment: 'jsdom',
    globals: false,
    restoreMocks: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
