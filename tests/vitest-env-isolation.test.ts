import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('root config excludes dotenv files while an unprotected positive control loads them', () => {
  // Only these disposable synthetic files are created/read. Never inspect checkout env files.
  const cwd = mkdtempSync(join(tmpdir(), 'team54-env-regression-'));
  const rootConfig = fileURLToPath(new URL('../vitest.config.mjs', import.meta.url));
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const sentinels = ['BASE', 'LOCAL', 'TEST', 'TEST_LOCAL'].map((suffix) => `VITE_TEAM54_SYNTHETIC_${suffix}`);
  try {
    ['.env', '.env.local', '.env.test', '.env.test.local'].forEach((name, index) => {
      writeFileSync(join(cwd, name), `${sentinels[index]}=disposable-fixture-only\n`);
    });
    writeFileSync(join(cwd, 'positive.config.mjs'), 'export default {};\n');
    const run = (config: string, loaded: boolean) => {
      // Globals avoid any package resolution/import from this temporary test project.
      writeFileSync(join(cwd, 'sentinel.test.mjs'), `
        it('checks only synthetic dotenv sentinels', () => {
          for (const key of ${JSON.stringify(sentinels)}) {
            expect(import.meta.env[key]).toBe(${loaded ? "'disposable-fixture-only'" : 'undefined'});
            ${loaded ? '' : 'expect(process.env[key]).toBeUndefined();'}
          }
          expect(process.env.TEAM54_EXPLICIT_VALIDATION_ENV).toBe('explicit-synthetic');
        });
      `);
      const result = spawnSync(process.execPath, [vitest, 'run', '--config', config,
        '--configLoader', 'native', '--no-cache', '--maxWorkers', '1', '--globals'], {
        cwd, encoding: 'utf8', timeout: 20_000,
        // env-i equivalent: no inherited credentials, paths, dotenv values or provider settings.
        env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test', TMPDIR: cwd,
          TEAM54_EXPLICIT_VALIDATION_ENV: 'explicit-synthetic' },
      });
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    };
    run(join(cwd, 'positive.config.mjs'), true);
    run(rootConfig, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 50_000);
