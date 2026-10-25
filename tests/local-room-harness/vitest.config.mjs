import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Never load the repository's .env files. The launcher also starts with env -i.
const emptyEnvDir = mkdtempSync(`${tmpdir()}/team54-empty-env-`);
process.once('exit', () => rmSync(emptyEnvDir, { recursive: true, force: true }));
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  envDir: emptyEnvDir,
  resolve: { alias: { '@': fileURLToPath(new URL('../..', import.meta.url)) } },
  test: {
    include: ['tests/local-room-harness/server.harness.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 1_830_000,
    hookTimeout: 30_000,
    silent: false,
  },
});
