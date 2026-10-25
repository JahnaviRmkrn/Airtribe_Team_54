// Runs once per server process before any request is handled.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { loadVaultSecrets } = await import('./lib/secrets');
  try {
    const loaded = await loadVaultSecrets();
    if (loaded.length) console.log(`secrets: loaded ${loaded.length} from Supabase Vault (${loaded.join(', ')})`);
  } catch (e) {
    // Optional features degrade (rule-based extraction, no voice) rather than
    // taking the whole site down when the vault is unreachable.
    console.warn('secrets: could not load from Supabase Vault:', e instanceof Error ? e.message : e);
  }
}
