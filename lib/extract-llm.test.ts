import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// extract-llm.ts imports 'server-only', which throws outside React Server
// Components; stub it so the provider logic is unit-testable in vitest.
vi.mock('server-only', () => ({}));

import { extract } from './extract-llm';

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EXTRACT_MODEL'];
const saved: Record<string, string | undefined> = {};

const LLM_JSON = JSON.stringify({
  contacts: [{ name: 'Priya', category: 'personal', interests: ['chai'], preferred_frequency_days: 7 }],
  goals: { personal: 60, professional: 30, community: 10 },
});

const openAiShape = (content: string) => ({ choices: [{ message: { content } }] });
const geminiShape = (content: string) => ({ candidates: [{ content: { parts: [{ text: content }] } }] });

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Error) throw out;
    return { ok: !(out as { status?: number }).status, status: (out as { status?: number }).status ?? 200, json: async () => out };
  });
  return calls;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('extract provider chain', () => {
  it('uses DeepSeek first when DEEPSEEK_API_KEY is set', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.OPENAI_API_KEY = 'o-key';
    const calls = mockFetch(() => openAiShape(LLM_JSON));

    const r = await extract('my sister Priya');
    expect(r.source).toBe('deepseek');
    expect(r.contacts[0]).toEqual({ name: 'Priya', category: 'personal', interests: ['chai'], preferred_frequency_days: 7 });
    expect(r.goals).toEqual({ personal: 60, professional: 30, community: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('deepseek-chat');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ds-key');
  });

  it('honours DEEPSEEK_BASE_URL and DEEPSEEK_MODEL overrides', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.DEEPSEEK_BASE_URL = 'https://deepseek.internal/v1/';
    process.env.DEEPSEEK_MODEL = 'deepseek-reasoner';
    const calls = mockFetch(() => openAiShape(LLM_JSON));

    await extract('hi');
    expect(calls[0].url).toBe('https://deepseek.internal/v1/chat/completions');
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('deepseek-reasoner');
  });

  it('falls through to Gemini when DeepSeek fails, then OpenAI', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.OPENAI_API_KEY = 'o-key';
    const calls = mockFetch((url) => {
      if (url.includes('deepseek')) return { status: 500 };
      if (url.includes('googleapis')) return new Error('network down');
      return openAiShape(LLM_JSON);
    });

    const r = await extract('my sister Priya');
    expect(r.source).toBe('openai');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.deepseek.com/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      'https://api.openai.com/v1/chat/completions',
    ]);
  });

  it('points the OpenAI provider at OPENAI_BASE_URL when set', async () => {
    process.env.OPENAI_API_KEY = 'o-key';
    process.env.OPENAI_BASE_URL = 'https://api.groq.com/openai/v1/';
    process.env.EXTRACT_MODEL = 'llama-3.3-70b';
    const calls = mockFetch(() => openAiShape(LLM_JSON));

    const r = await extract('hi');
    expect(r.source).toBe('openai');
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('llama-3.3-70b');
  });

  it('skips providers without keys', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const calls = mockFetch(() => geminiShape(LLM_JSON));

    const r = await extract('my sister Priya');
    expect(r.source).toBe('gemini');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('googleapis');
  });

  it('treats invalid LLM JSON as a failed call and falls back to rules', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    mockFetch(() => openAiShape('not json at all'));

    const r = await extract('call my brother Sam weekly');
    expect(r.source).toBe('rules');
    expect(r.contacts.map((c) => c.name)).toEqual(['Sam']);
  });

  it('validates LLM output against the loose schema before trusting it', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    mockFetch(() => openAiShape(JSON.stringify({ totally: 'wrong' })));

    const r = await extract('call my brother Sam weekly');
    // llmOutput accepts almost anything; clean() normalises it into a valid result.
    expect(r.source).toBe('deepseek');
    expect(r.contacts).toEqual([]);
    expect(r.goals.personal + r.goals.professional + r.goals.community).toBe(100);
  });

  it('never calls the network when no key is set', async () => {
    const calls = mockFetch(() => openAiShape(LLM_JSON));

    const r = await extract('call my brother Sam weekly');
    expect(r.source).toBe('rules');
    expect(calls).toHaveLength(0);
  });
});
