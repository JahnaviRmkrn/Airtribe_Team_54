import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the organizer's desktop-panel script with a minimal fake DOM.
const source = readFileSync(new URL('../public/organizer/desktop.js', import.meta.url), 'utf8');

function load(bridge) {
  const created = [];
  const topbar = { appendChild(el) { created.push(el); } };
  const document = {
    head: { appendChild() {} },
    body: { appendChild(el) { created.push(el); } },
    createElement(tag) {
      const el = {
        tag, id: '', type: '', textContent: '', title: '', hidden: false, style: {},
        listeners: {},
        addEventListener(name, fn) { this.listeners[name] = fn; },
        querySelector() { return null; },
      };
      created.push(el);
      return el;
    },
    querySelector(sel) { return sel === '.topbar' ? topbar : null; },
  };
  const context = vm.createContext({
    document,
    window: bridge ? { muopDesktop: bridge } : {},
    navigator: {},
    console,
  });
  vm.runInContext(source, context);
  return created;
}

describe('organizer desktop panel', () => {
  it('renders nothing in a plain browser (no bridge)', () => {
    const created = load(null);
    expect(created.filter((el) => el.id === 'muop-desktop-btn')).toHaveLength(0);
  });

  it('adds a Desktop button in the desktop app', () => {
    const created = load({ isDesktop: true, platform: 'linux' });
    const btn = created.find((el) => el.id === 'muop-desktop-btn');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('Desktop');
  });

  it('bridge surface the panel uses exists in the preload contract', () => {
    const preload = readFileSync(new URL('../desktop/preload.js', import.meta.url), 'utf8');
    for (const fn of ['pickAndReadFiles', 'saveTextFile', 'captureScreen', 'getContacts', 'getNotes', 'getReminders', 'createReminder', 'getMessageChats']) {
      expect(preload).toContain(fn);
      expect(source).toContain(fn === 'pickAndReadFiles' || fn === 'saveTextFile' || fn === 'captureScreen' || fn === 'createReminder'
        ? fn : fn);
    }
    expect(source).toContain('getDisplayMedia');
  });
});
