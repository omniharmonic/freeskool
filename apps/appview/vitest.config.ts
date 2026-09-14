import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The DB-backed suites truncate `fs_*` tables: keep them off the dev database the
    // AppView and the demo seed use. `global-setup.ts` creates + migrates this one.
    // Unconditional on purpose: a shell that exported the repo .env carries the DEV
    // DATABASE_URL, and the suites would truncate the dev data. TEST_DATABASE_URL overrides.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://freeschool:freeschool@localhost:5434/freeschool_test' },
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Several suites truncate shared tables (fs_custodial_account, fs_steward, …) in a
    // live Postgres; running test FILES in parallel races those truncations against
    // each other's inserts (pre-existing, observed while adding Task 9's suites — not
    // specific to any one file). Sequential files keep the live-DB suites deterministic
    // without changing within-file behavior.
    fileParallelism: false,
  },
})
