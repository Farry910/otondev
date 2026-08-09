import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * One run for the whole workspace.
 *
 * Workspace packages are aliased to their **source**, not their build output, so
 * `pnpm test` needs no prior build and a session never debugs a stale `dist/`. The
 * compiler resolves the same specifiers through the package `exports` field instead,
 * which is what `pnpm run typecheck` and the boundary cruise exercise.
 */
const src = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@otondev/contracts': src('contracts'),
      '@otondev/testkit': src('testkit'),
      '@otondev/sdk': src('sdk'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'services/*/src/**/*.test.ts',
      'windows/*/test/**/*.test.ts',
      'eval/**/*.test.ts',
      'integration/**/*.test.ts',
      'scripts/__tests__/**/*.test.mjs',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/fixtures/**'],
    // Property 6 of an independent package: tests run green with all peers faked and no
    // network. The guard makes that a mechanical fact rather than a convention.
    setupFiles: ['./scripts/vitest-offline-guard.mjs'],
    environment: 'node',
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['**/dist/**', 'scripts/fixtures/**', '**/*.test.ts'],
    },
  },
});
