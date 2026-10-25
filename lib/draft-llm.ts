import 'server-only';
import { buildDraftPrompt, cleanDraft, draftBasis, templateBasis, templateDraft, type DraftContact, type DraftInteraction } from './draft';

// Same provider order as extract-llm.ts: the user's DeepSeek key first, then any
// OpenAI-compatible endpoint (OPENAI_API_KEY + OPENAI_BASE_URL), then the
// template, so "Draft message" never dead-ends. Keys are server-only.

const TIMEOUT_MS = 15_000;

async function chat(base: string, key: string, model: string, prompt: string): Promise<unknown> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.8, max_tokens: 160, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`LLM provider returned ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content;
}

type Source = 'deepseek' | 'openai' | 'template';

const PROVIDERS: { name: Exclude<Source, 'template'>; key: () => string | undefined; base: () => string; model: () => string }[] = [
  {
    name: 'deepseek',
    key: () => process.env.DEEPSEEK_API_KEY,
    base: () => process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: () => process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  {
    name: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    base: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: () => process.env.EXTRACT_MODEL || 'gpt-4o-mini',
  },
];

export async function draftMessage(contact: DraftContact, recent: DraftInteraction[]): Promise<{ message: string; source: Source; basis: string[] }> {
  const now = new Date();
  const prompt = buildDraftPrompt(contact, recent, now);
  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    try {
      const message = cleanDraft(await chat(p.base(), key, p.model(), prompt));
      if (message) return { message, source: p.name, basis: draftBasis(contact, recent, now) };
      console.warn(`draft: ${p.name} returned an unusable message, trying next provider`);
    } catch (e) {
      // Never log the prompt: it carries the user's contact notes.
      console.warn(`draft: ${p.name} call failed, trying next provider:`, e instanceof Error ? e.message : e);
    }
  }
  return { message: templateDraft(contact), source: 'template', basis: templateBasis(contact) };
}
