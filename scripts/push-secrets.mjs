// Uploads the app's API keys from an untracked env file into Supabase Vault.
//   node scripts/push-secrets.mjs secrets.env            # target from .env.local
//   ENV_FILE=.env.production.local node scripts/push-secrets.mjs secrets.env
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the real env
// or ENV_FILE (default .env.local). Only names in lib/secrets.ts are pushed.
// Never prints values.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';

// Node's dotenv-compatible parser: handles `KEY = value`, quotes, `export`
// and trailing `# comments`. Note `#` starts a comment even without a space,
// so quote any value that contains one (A="x#y").
const parse = (file) => (existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {});

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('usage: node scripts/push-secrets.mjs <secrets-file>');
  process.exit(1);
}
// The source holds live keys: refuse one that git would happily commit.
// Anchored to this repo (not the caller's cwd): a file outside it is fine,
// one inside must be git-ignored and untracked, and any git error fails closed.
const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const rel = relative(repo, realpathSync(resolve(src)));
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status;
// check-ignore: 0 = ignored. ls-files --error-unmatch: 1 = untracked. Anything else blocks.
const outside = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
if (!outside && !(git('check-ignore', '-q', '--no-index', rel) === 0 && git('ls-files', '--error-unmatch', rel) === 1)) {
  console.error(`${src} is inside the repo but not git-ignored (or is tracked); name it secrets.env (or .env.*) or keep it outside the repo`);
  process.exit(1);
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
