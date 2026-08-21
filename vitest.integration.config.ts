import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Same suite, but with INTEGRATION=1 so the driver contract tests also run
// against real Redis and PostgreSQL instead of skipping them.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    env: { INTEGRATION: '1' },
  },
});
