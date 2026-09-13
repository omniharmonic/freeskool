import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
