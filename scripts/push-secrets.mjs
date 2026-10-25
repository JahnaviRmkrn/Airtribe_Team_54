// Uploads the app's API keys from an untracked env file into Supabase Vault.
//   node scripts/push-secrets.mjs secrets.env            # target from .env.local
//   ENV_FILE=.env.production.local node scripts/push-secrets.mjs secrets.env
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the real env
// or ENV_FILE (default .env.local). Only names in lib/secrets.ts are pushed.
// Never prints values.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const parse = (file) =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('=') && !l.startsWith('#'))
          .map((l) => [l.slice(0, l.indexOf('=')).replace(/^export\s+/, ''), l.slice(l.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2')]),
      )
    : {};

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('usage: node scripts/push-secrets.mjs <secrets-file>');
  process.exit(1);
}
// The source holds live keys: refuse one that git would happily commit.
// check-ignore exits 1 for a tracked-able path; 128 means outside the repo (fine).
try {
  execFileSync('git', ['check-ignore', '-q', src], { stdio: 'ignore' });
} catch (e) {
  if (e.status === 1) {
    console.error(`${src} is not git-ignored; name it secrets.env (or .env.*) or keep it outside the repo`);
    process.exit(1);
  }
  if (e.status !== 128) throw e;
}
const names = [...readFileSync(new URL('../lib/secrets.ts', import.meta.url), 'utf8').matchAll(/^\s+'([A-Z0-9_]+)',$/gm)].map((m) => m[1]);
const target = { ...parse(process.env.ENV_FILE ?? '.env.local'), ...process.env };
const url = target.NEXT_PUBLIC_SUPABASE_URL;
const key = target.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}
console.log(`target ${new URL(url).host}`);
const supabase = createClient(url, key, { auth: { persistSession: false } });
const secrets = parse(src);
let failed = 0;
for (const name of names) {
  if (!secrets[name]) continue;
  const { error } = await supabase.rpc('set_app_secret', { secret_name: name, secret_value: secrets[name] });
  console.log(`${error ? 'FAIL' : 'ok  '} ${name}${error ? ` (${error.message})` : ''}`);
  if (error) failed++;
}
process.exit(failed ? 1 : 0);
