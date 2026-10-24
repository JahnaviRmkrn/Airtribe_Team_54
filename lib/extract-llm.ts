import 'server-only';
import { clean, EXTRACT_PROMPT, llmOutput, ruleExtract, type ExtractResult } from './extract';

// Calls Gemini (if GEMINI_API_KEY is set) or OpenAI (if OPENAI_API_KEY is set;
// OPENAI_BASE_URL points it at any OpenAI-compatible API, e.g. DeepSeek)
// and falls back to the rule-based parser on any failure, so onboarding never
// dead-ends. Keys are server-only and never reach the browser.

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

async function gemini(text: string, key: string): Promise<string> {
  const model = encodeURIComponent(process.env.EXTRACT_MODEL || 'gemini-2.0-flash');
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
  const data = await postJson(
    `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`,
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

export async function extract(transcript: string): Promise<ExtractResult & { source: 'gemini' | 'openai' | 'rules' }> {
  const gKey = process.env.GEMINI_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  // WARNING: the transcript is user-controlled and goes into the prompt, so a
  // user can steer the model (prompt injection). The output is only shown back
  // to that same user for editing, is never saved here, and is schema-checked
  // and clamped below, so the blast radius is limited to their own pre-fill.
  try {
    if (gKey || oKey) {
      const raw = gKey ? await gemini(transcript, gKey) : await openai(transcript, oKey!);
      const parsed = llmOutput.safeParse(JSON.parse(String(raw)));
      if (parsed.success) return { ...clean(parsed.data), source: gKey ? 'gemini' : 'openai' };
      console.warn('extract: LLM output failed validation, using rules');
    }
  } catch (e) {
    // LLM down / bad key / bad JSON -> rules. Never log the transcript.
    console.warn('extract: LLM call failed, using rules:', e instanceof Error ? e.message : e);
  }
  return { ...ruleExtract(transcript), source: 'rules' };
}
