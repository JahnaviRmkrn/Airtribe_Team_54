import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/secrets', () => ({ loadVaultSecrets: () => { throw new Error('Vault forbidden'); } }));
import { draftMessage } from '../lib/draft-llm';
const contact = { name: 'Alice Jones', category: 'personal' as const, interests: ['books'], notes: 'Synthetic private note', last_interaction_at: null };
const recent = [{ occurred_at: '2026-10-01', notes: 'Synthetic earlier note' }];
beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', ''); vi.stubEnv('OPENAI_API_KEY', ''); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unmocked provider call forbidden'); })); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('draft provider failures never send and retain truthful template provenance', () => {
  it('uses an editable template without provider access when no provider is configured', async () => {
    const result = await draftMessage(contact, recent); expect(result.source).toBe('template'); expect(result.message).toContain('Alice');
    expect(result.basis).toEqual(['Written from a template (no AI)', 'Relationship: personal', 'Interested in books']); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['network', 'http', 'invalid-json', 'placeholder', 'nontext'])('recovers from %s failure without claiming notes/history were used by the template', async (failure) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-key'); vi.stubEnv('DEEPSEEK_BASE_URL', 'https://synthetic.example.test');
    vi.mocked(fetch).mockImplementation(async () => {
      if (failure === 'network') throw new Error('Synthetic timeout');
      if (failure === 'http') return new Response('{}', { status: 503 });
      if (failure === 'invalid-json') return new Response('invalid', { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: failure === 'placeholder' ? 'Hello [Name]' : { bad: true } } }] }), { status: 200 });
    });
    const result = await draftMessage(contact, recent); expect(result.source).toBe('template'); expect(result.basis.join(' ')).not.toMatch(/Synthetic|notes|history/i);
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://synthetic.example.test/chat/completions');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('Synthetic private note');
  });
});
