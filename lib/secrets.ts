import 'server-only';
import { adminClient } from './supabase/admin';

// API keys are stored in Supabase Vault (migration 20261025090000), not in git.
// At server boot instrumentation.ts copies them into process.env, so callers
// keep reading process.env.X. A value already set in the real env wins, which
// keeps local overrides working. Only these names are ever copied: the
// bootstrap trio (Supabase URL, anon key, service-role key) must stay in env.
// Endpoint/model settings travel with their keys, so an OpenAI-compatible
// provider (e.g. DeepSeek via OPENAI_BASE_URL) keeps working after migration.
export const VAULT_SECRETS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'EXTRACT_MODEL',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'AGENTICORG_API_KEY',
  'AGENTICORG_AGENT_ID',
  'AGENTICORG_BASE_URL',
  'PINE_CLIENT_ID',
  'PINE_CLIENT_SECRET',
  'PINE_ENV',
  'TRACTION_TEAM_NAMES',
  'TRACTION_EXCLUDE_ATTENDEES',
] as const;

const VAULT_TIMEOUT_MS = 5_000;

// A vault base URL must never redirect a key that lives in the real env to
// another host, and must be plain https. So DEEPSEEK_BASE_URL is only taken
// when DEEPSEEK_API_KEY also comes from the vault (OPENAI_* likewise).
function safeBaseUrl(name: string, value: string, rows: Map<string, string | null>): boolean {
  const keyName = name.replace(/_BASE_URL$/, '_API_KEY');
  if (keyName !== name && process.env[keyName] && !rows.get(keyName)) {
    console.warn(`secrets: ignoring vault ${name} because ${keyName} comes from env`);
    return false;
  }
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password) return true;
  } catch { /* fall through */ }
  console.warn(`secrets: ignoring vault ${name}: must be an https URL without credentials`);
  return false;
}

export async function loadVaultSecrets(): Promise<string[]> {
  const missing = VAULT_SECRETS.filter((n) => !process.env[n]);
  if (!missing.length) return [];
  // Boot awaits this: a stalled vault must not hold every request, so give up
  // after a few seconds and let optional features degrade.
  const { data, error } = await adminClient()
    .rpc('app_secrets', { names: missing })
    .abortSignal(AbortSignal.timeout(VAULT_TIMEOUT_MS));
  if (error) throw new Error(`vault read failed: ${error.message}`);
  const rows = new Map(((data ?? []) as { name: string; secret: string | null }[]).map((r) => [r.name, r.secret]));
  const loaded: string[] = [];
  for (const name of missing) {
    const value = rows.get(name);
    if (!value || process.env[name]) continue;
    if (name.endsWith('_BASE_URL') && !safeBaseUrl(name, value, rows)) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
