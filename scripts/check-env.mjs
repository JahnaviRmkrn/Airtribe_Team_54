// Validates the app's env (presence + shape). Exit 1 on any problem.
//   pnpm check-env                 # process env + .env.local
//   pnpm check-env --prod          # also require https, hosted Supabase, NEXT_PUBLIC_SITE_URL
//   ENV_FILE=.env.prod pnpm check-env --prod
// Never prints key values.
import { existsSync, readFileSync } from 'node:fs';

const prod = process.argv.includes('--prod');
const file = process.env.ENV_FILE ?? '.env.local';
const fromFile = existsSync(file)
  ? Object.fromEntries(
      readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('=') && !l.startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).replace(/^export\s+/, ''), l.slice(l.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2')]),
    )
  : {};
// Same precedence as Next.js: real env wins over the file.
const env = { ...fromFile, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')) };

const errors = [];
const fail = (name, msg) => void errors.push(`${name}: ${msg}`);

const jwtPayload = (v) => {
  const parts = v.split('.');
  if (parts.length !== 3 || !v.startsWith('eyJ')) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};
// Legacy JWT keys carry a role; new-style keys are sb_publishable_* / sb_secret_*.
const keyRole = (v) => (v.startsWith('sb_secret_') ? 'service_role' : v.startsWith('sb_publishable_') ? 'anon' : jwtPayload(v)?.role ?? null);

function url(name, { required = true } = {}) {
  const v = env[name];
  if (!v) return required ? fail(name, 'missing') : undefined;
  let u;
  try {
    u = new URL(v);
  } catch {
    return fail(name, `not a URL ("${v}")`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(name, 'must be http(s)');
  if (u.pathname !== '/' || u.search || u.hash) fail(name, 'must be an origin only, no path (e.g. https://app.example.com)');
  if (prod && u.protocol !== 'https:') fail(name, 'must be https in production');
  if (prod && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(u.hostname)) fail(name, 'points at localhost');
  return u;
}

const sbUrl = url('NEXT_PUBLIC_SUPABASE_URL');
url('NEXT_PUBLIC_SITE_URL', { required: prod });
const ref = sbUrl?.hostname.endsWith('.supabase.co') ? sbUrl.hostname.split('.')[0] : null;

function key(name, role) {
  const v = env[name];
  if (!v) return fail(name, 'missing');
  const r = keyRole(v);
  if (!r) return fail(name, 'not a Supabase key (expected a JWT or sb_publishable_/sb_secret_ key)');
  if (r !== role) fail(name, `has role "${r}", expected "${role}"`);
  const jwtRef = jwtPayload(v)?.ref;
  if (ref && jwtRef && jwtRef !== ref) fail(name, `belongs to project "${jwtRef}" but NEXT_PUBLIC_SUPABASE_URL is "${ref}"`);
}

key('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
key('SUPABASE_SERVICE_ROLE_KEY', 'service_role');

// Anything NEXT_PUBLIC_ ships to the browser: no secrets there, by name or by value.
for (const [name, v] of Object.entries(env)) {
  if (!name.startsWith('NEXT_PUBLIC_')) continue;
  if (/SERVICE_ROLE|SECRET|PASSWORD|PRIVATE/i.test(name)) fail(name, 'secret-looking name is exposed to the browser; drop the NEXT_PUBLIC_ prefix');
  else if (v && keyRole(v) === 'service_role') fail(name, 'holds a service-role/secret key and would ship to the browser');
}

if (errors.length) {
  console.error(`check-env: ${errors.length} problem(s)${existsSync(file) ? ` (read ${file} + process env)` : ' (process env only)'}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-env: OK${prod ? ' (production)' : ''}`);
