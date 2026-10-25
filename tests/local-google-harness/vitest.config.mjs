import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const emptyEnvDir = mkdtempSync(`${tmpdir()}/team54-google-empty-env-`);
process.once('exit', () => rmSync(emptyEnvDir, { recursive: true, force: true }));
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), envDir: emptyEnvDir,
  resolve: { alias: { '@': fileURLToPath(new URL('../..', import.meta.url)) } },
  test: {
    include: ['tests/local-google-harness/routes.harness.mjs'],
    fileParallelism: false, maxWorkers: 1, testTimeout: 10_000, hookTimeout: 30_000,
  },
});
