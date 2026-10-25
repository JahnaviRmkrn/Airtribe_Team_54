import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const rows: { name: string; secret: string }[] = [];
vi.mock('./supabase/admin', () => ({
  adminClient: () => ({
    rpc: () => ({ abortSignal: async () => ({ data: rows, error: null }) }),
  }),
}));

import { loadVaultSecrets, VAULT_SECRETS } from './secrets';

const saved = { ...process.env };
beforeEach(() => {
  for (const n of VAULT_SECRETS) delete process.env[n];
  rows.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('loadVaultSecrets', () => {
  it('loads allowlisted values and lets real env win', async () => {
    process.env.GEMINI_API_KEY = 'from-env';
    rows.push({ name: 'GEMINI_API_KEY', secret: 'from-vault' }, { name: 'DEEPSEEK_API_KEY', secret: 'ds' });
    await loadVaultSecrets();
    expect(process.env.GEMINI_API_KEY).toBe('from-env');
    expect(process.env.DEEPSEEK_API_KEY).toBe('ds');
  });

  it('takes a vault base URL together with its vault key', async () => {
    rows.push({ name: 'OPENAI_API_KEY', secret: 'k' }, { name: 'OPENAI_BASE_URL', secret: 'https://api.deepseek.com/v1' });
    await loadVaultSecrets();
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
  });

  it('never points an env-held key at a vault base URL', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    rows.push({ name: 'OPENAI_BASE_URL', secret: 'https://attacker.example/v1' });
    await loadVaultSecrets();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it('rejects non-https or credentialed base URLs', async () => {
    rows.push(
      { name: 'DEEPSEEK_API_KEY', secret: 'k' },
      { name: 'DEEPSEEK_BASE_URL', secret: 'http://api.deepseek.com' },
      { name: 'OPENAI_API_KEY', secret: 'k' },
      { name: 'OPENAI_BASE_URL', secret: 'https://u:p@host.example/v1' },
    );
    await loadVaultSecrets();
    expect(process.env.DEEPSEEK_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it('ignores names outside the allowlist', async () => {
    rows.push({ name: 'NODE_OPTIONS', secret: '--require evil' });
    await loadVaultSecrets();
    expect(process.env.NODE_OPTIONS).toBe(saved.NODE_OPTIONS);
  });
});
