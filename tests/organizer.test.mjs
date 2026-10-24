import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the shipped browser script without starting its automatic boot request.
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8')
  .replace(/\nboot\(\);\s*$/, '');

function organizer(overrides = {}) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', classList: { remove() {} } });
      return nodes.get(id);
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document,
    location: { origin: 'https://example.test', hash: '' },
    ...overrides,
  });
  vm.runInContext(source, context);
  return { context, document };
}

const attack = '<img src=x onerror=alert(1)>';
const escaped = '&lt;img src=x onerror=alert(1)&gt;';

describe('organizer meetup rendering', () => {
  it('escapes stored meetup areas in the planned list', () => {
    const { context } = organizer();
    context.meetup = { id: 'one', title: 'Coffee', area: attack };
    const html = vm.runInContext('meetupRow(meetup)', context);
    expect(html).toContain(escaped);
    expect(html).not.toContain(attack);
  });

  it('escapes stored meetup areas in the dashboard', async () => {
    const { context, document } = organizer({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({
        is_empty: false,
        upcoming_meetups: [{ title: 'Coffee', area: attack }],
      }) }),
    });
    await vm.runInContext('dashboardView()', context);
    expect(document.getElementById('app').innerHTML).toContain(escaped);
    expect(document.getElementById('app').innerHTML).not.toContain(attack);
  });
});
