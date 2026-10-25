import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8').replace(/\nboot\(\);\s*$/, '');
describe('shipped contact-row accessible names', () => {
  it('keeps visible Open and gives multiple contacts distinct escaped names', () => {
    const context = vm.createContext({ window: {}, document: {} });
    vm.runInContext(source, context);
    context.contacts = [
      { id: 'alice', name: 'Alice & "Friends" <team>', category: 'personal' },
      { id: 'bob', name: "Bob's circle", category: 'professional' },
      { id: 'unnamed', name: '', category: 'community' },
    ];
    const rows = vm.runInContext('contacts.map(contactRow)', context);
    expect(rows[0]).toContain('aria-label="Open contact: Alice &amp; &quot;Friends&quot; &lt;team&gt;">Open</button>');
    expect(rows[1]).toContain('aria-label="Open contact: Bob&#39;s circle">Open</button>');
    expect(rows[2]).toContain('aria-label="Open contact: Unnamed contact">Open</button>');
    expect(rows.every((row) => row.includes('>Open</button>'))).toBe(true);
    expect(rows[0]).not.toContain('<team>');
    expect(rows.map((row) => row.match(/data-view="([^"]+)"/)[1])).toEqual(['alice', 'bob', 'unnamed']);
  });
});
