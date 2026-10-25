import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/organizer/assistant.js', import.meta.url), 'utf8');

describe('generic assistant clicks cannot launch external communications apps', () => {
  it.each(['mailto:alice@example.test?subject=Hello', 'sms:?body=Hello', 'https://wa.me/?text=Hello'])('requires a manual handoff for %s', async (href) => {
    const button = { id: '', dataset: {}, innerText: 'Email', offsetWidth: 10, getAttribute: (name) => name === 'href' ? href : null, click: vi.fn() };
    const window = { OrganizerAccount: { currentOwner: () => 'synthetic-owner' }, addEventListener: vi.fn() };
    const fetch = vi.fn(() => { throw new Error('No external operations permitted'); });
    vm.runInNewContext(source, { window, document: { querySelectorAll: () => [button] }, location: { hash: '#/contacts' }, fetch });
    const result = await window.Assistant.call('click', { label: 'Email' });
    expect(result.error).toMatch(/manual|yourself/i); expect(button.click).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
