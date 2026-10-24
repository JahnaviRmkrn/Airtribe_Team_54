import 'server-only';
import { clean, EXTRACT_PROMPT, llmOutput, ruleExtract, type ExtractResult } from './extract';
import { extractWithAgenticOrg } from './agenticorg';

// AgenticOrg is an explicit opt-in and its failures never fall through.
// Calls the first configured LLM provider - DeepSeek (DEEPSEEK_API_KEY), then
// Gemini (GEMINI_API_KEY), then OpenAI (OPENAI_API_KEY; OPENAI_BASE_URL points
// it at any OpenAI-compatible API) - and on any failure tries the next one,
// ending with the rule-based parser, so onboarding never dead-ends.
// Keys are server-only and never reach the browser.

const TIMEOUT_MS = 20_000;

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`LLM provider returned ${res.status}`);
  return res.json();
}

// DeepSeek's OpenAI-compatible chat API (https://api-docs.deepseek.com).
async function deepseek(text: string, key: string): Promise<string> {
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const data = await postJson(
    `${base}/chat/completions`,
    {
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: EXTRACT_PROMPT + text }],
    },
    { Authorization: `Bearer ${key}` },
  );
  return data?.choices?.[0]?.message?.content;
}

async function gemini(text: string, key: string): Promise<string> {
  const model = encodeURIComponent(process.env.GEMINI_MODEL || 'gemini-3.8-flash');
  // Key goes in a header, not the query string, so it never lands in URL logs.
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      contents: [{ parts: [{ text: EXTRACT_PROMPT + text }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    },
    { 'x-goog-api-key': key },
  );
  return data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function openai(text: string, key: string): Promise<string> {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const data = await postJson(
    `${base}/chat/completions`,
    {
      model: process.env.EXTRACT_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: EXTRACT_PROMPT + text }],
    },
    { Authorization: `Bearer ${key}` },
  );
  return data?.choices?.[0]?.message?.content;
}

type ProviderName = 'deepseek' | 'gemini' | 'openai';

// Order matters: the user's DeepSeek key is the primary extractor; the others
// stay as drop-in alternates for environments that only have those keys.
const PROVIDERS: { name: ProviderName; env: string; call: (text: string, key: string) => Promise<string> }[] = [
  { name: 'deepseek', env: 'DEEPSEEK_API_KEY', call: deepseek },
  { name: 'gemini', env: 'GEMINI_API_KEY', call: gemini },
  { name: 'openai', env: 'OPENAI_API_KEY', call: openai },
];

export async function extract(transcript: string): Promise<ExtractResult & { source: ProviderName | 'rules' | 'agenticorg' }> {
  // WARNING: the transcript is user-controlled and goes into the prompt, so a
  // user can steer the model (prompt injection). The output is only shown back
  // to that same user for editing, is never saved here, and is schema-checked
  // and clamped below, so the blast radius is limited to their own pre-fill.
  const platformResult = await extractWithAgenticOrg(transcript);
  if (platformResult) return { ...platformResult, source: 'agenticorg' };
  for (const p of PROVIDERS) {
    const key = process.env[p.env];
    if (!key) continue;
    try {
      const raw = await p.call(transcript, key);
      const parsed = llmOutput.safeParse(JSON.parse(String(raw)));
      if (parsed.success) return { ...clean(parsed.data), source: p.name };
      console.warn(`extract: ${p.name} output failed validation, trying next provider`);
    } catch (e) {
      // LLM down / bad key / bad JSON -> next provider, then rules. Never log the transcript.
      console.warn(`extract: ${p.name} call failed, trying next provider:`, e instanceof Error ? e.message : e);
    }
  }
  return { ...ruleExtract(transcript), source: 'rules' };
}
