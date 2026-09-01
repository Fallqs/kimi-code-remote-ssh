import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'remote-ssh',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
