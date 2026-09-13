/**
 * Vitest runs with `globals: false` (see `vitest.config.ts`), so
 * `@testing-library/react`'s automatic cleanup never finds an `afterEach` to
 * hook into — it is wired up by hand here instead. Imported via
 * `test.setupFiles`, once, for every test file in this package.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
