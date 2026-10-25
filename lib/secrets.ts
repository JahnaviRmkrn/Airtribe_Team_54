import 'server-only';
import { adminClient } from './supabase/admin';

// API keys are stored in Supabase Vault (migration 20261025090000), not in git.
// At server boot instrumentation.ts copies them into process.env, so callers
// keep reading process.env.X. A value already set in the real env wins, which
// keeps local overrides working. Only these names are ever copied: the
// bootstrap trio (Supabase URL, anon key, service-role key) must stay in env.
export const VAULT_SECRETS = [
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'AGENTICORG_API_KEY',
  'AGENTICORG_AGENT_ID',
  'PINE_CLIENT_ID',
  'PINE_CLIENT_SECRET',
  'TRACTION_TEAM_NAMES',
  'TRACTION_EXCLUDE_ATTENDEES',
] as const;

export async function loadVaultSecrets(): Promise<string[]> {
  const missing = VAULT_SECRETS.filter((n) => !process.env[n]);
  if (!missing.length) return [];
  const { data, error } = await adminClient().rpc('app_secrets', { names: missing });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  const loaded: string[] = [];
  for (const row of (data ?? []) as { name: string; secret: string | null }[]) {
    if (!(VAULT_SECRETS as readonly string[]).includes(row.name) || !row.secret || process.env[row.name]) continue;
    process.env[row.name] = row.secret;
    loaded.push(row.name);
  }
  return loaded;
}
