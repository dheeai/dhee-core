import { defineConfig } from 'vitest/config';

// Disable the cross-project content-addressed cache for tests so stale
// entries from a previous test run can't leak into a fresh suite.
// Production runs (CLI / desktop) leave this unset and hit the real CAS.
process.env['DHEE_DISABLE_CAS'] = '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Run test files sequentially to avoid race conditions with shared state (e.g., .dhee directory)
    fileParallelism: false,
    env: {
      DHEE_DISABLE_CAS: '1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/index.tsx', 'src/**/*.d.ts'],
    },
  },
});
