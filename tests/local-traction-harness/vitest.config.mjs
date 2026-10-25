import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const emptyEnvDir = mkdtempSync(`${tmpdir()}/team54-traction-empty-env-`);
process.once('exit', () => rmSync(emptyEnvDir, { recursive: true, force: true }));
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), envDir: emptyEnvDir,
  resolve: { alias: { '@': fileURLToPath(new URL('../..', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['tests/local-traction-harness/server.harness.mjs'], fileParallelism: false, maxWorkers: 1,
    testTimeout: 1_830_000, hookTimeout: 30_000 },
});
