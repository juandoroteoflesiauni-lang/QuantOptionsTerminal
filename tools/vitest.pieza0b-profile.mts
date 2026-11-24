import { defineConfig } from 'vitest/config';

// Diagnostic only: same 15 s per-test limit; no legacy tests or verify config changed.
// Set PIEZA0B_PROFILE_OUTPUT to an artifact directory, then run:
// node node_modules/vitest/vitest.mjs run --config tools/vitest.pieza0b-profile.mts
// Set PIEZA0B_BENCHMARK=1 for the separate comparative HTTP benchmark and JSON report.
export default defineConfig({
  test: {
    include: ['tests/pieza0BMassiveHistoricalIntegrity.test.ts'],
    setupFiles: ['tools/pieza0b_profile_setup.mts'],
    testTimeout: 15000,
    pool: 'forks', maxWorkers: 1, minWorkers: 1,
  },
});
