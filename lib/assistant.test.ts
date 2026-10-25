import { describe, expect, it } from 'vitest';
import { assistantBody, fromChatResponse, toChatRequest, toJsonSchema } from './assistant';

const body = assistantBody.parse({
  messages: [{ role: 'user', content: 'add Priya' }],
  tools: [{ name: 'add_contact', description: 'Add', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } }],
});

describe('assistant (DeepSeek tool-calling fallback)', () => {
  it('converts Gemini schemas to JSON Schema', () => {
    expect(toJsonSchema({ type: 'OBJECT', properties: { tags: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['tags'] }))
      .toEqual({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] });
  });

  it('builds an OpenAI-style request with a system prompt and function tools', () => {
    const r = toChatRequest(body, 'deepseek-chat');
    expect(r.messages[0].role).toBe('system');
    expect(r.tools[0]).toMatchObject({ type: 'function', function: { name: 'add_contact', parameters: { type: 'object' } } });
  });

  it('only passes through calls to declared tools', () => {
    const out = fromChatResponse({ choices: [{ message: { content: '', tool_calls: [
      { id: 'a', function: { name: 'add_contact', arguments: '{"name":"Priya"}' } },
      { id: 'b', function: { name: 'drop_database', arguments: '{}' } },
    ] } }] }, body);
    expect(out.tool_calls).toEqual([{ id: 'a', name: 'add_contact', arguments: '{"name":"Priya"}' }]);
  });

  it('rejects bad tool names and oversized input', () => {
    expect(assistantBody.safeParse({ ...body, tools: [{ name: 'Bad Name!', description: '' }] }).success).toBe(false);
    expect(assistantBody.safeParse({ ...body, messages: [{ role: 'user', content: 'x'.repeat(5000) }] }).success).toBe(false);
  });
});

describe('malformed assistant provider output', () => {
  it.each([null, {}, { choices: [{ message: {} }] }, { choices: [{ message: { content: { fake: true } } }] }, { choices: [{ message: { tool_calls: {} } }] }])('rejects unusable output %#', (data) => {
    expect(() => fromChatResponse(data, body)).toThrow('Assistant model returned an invalid response');
  });
  it.each(['not JSON', '[]', 'null', '{"name":"' + 'a'.repeat(4000) + '"}'])('never truncates or forwards invalid action arguments', (argumentsText) => {
    expect(() => fromChatResponse({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'add_contact', arguments: argumentsText } }] } }] }, body)).toThrow('Assistant model returned an invalid response');
  });
  it('rejects repeated tool IDs instead of executing two actions under one receipt', () => {
    expect(() => fromChatResponse({ choices: [{ message: { tool_calls: [
      { id: 'same', function: { name: 'add_contact', arguments: '{"name":"Alice"}' } },
      { id: 'same', function: { name: 'add_contact', arguments: '{"name":"Bob"}' } },
    ] } }] }, body)).toThrow('Assistant model returned an invalid response');
  });
});
