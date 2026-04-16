import { defineConfig } from 'vitest/config';

// Backend test config.  Frontend has its own (or doesn't yet — utilities are
// duplicated to backend so they get coverage here).
//
// Setup file populates env defaults so getConfig() can validate without
// requiring a real .env on test machines / CI.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'services/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'external/**', 'dist/**', 'frontend/**', 'services/*/frontend/**'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    // Each test file gets its own worker so the getConfig() / KeyProvider
    // module-level caches stay isolated and can be reset per-suite.
    isolate: true,
    pool: 'forks',
  },
});
