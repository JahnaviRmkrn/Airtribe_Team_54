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
    include: process.env.TEAM54_ORGANIZER_HARNESS_MODE === 'verify' ? [
      'tests/organizer-adapter.test.mjs',
      'tests/private-data-isolation.test.mjs',
      'tests/room-privacy.test.mjs',
      'tests/meetup-edit-routes.test.mjs',
      'tests/contact-create-sql.test.mjs',
    ] : ['tests/local-organizer-harness/server.harness.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 1_830_000,
    hookTimeout: 30_000,
    silent: false,
  },
});
