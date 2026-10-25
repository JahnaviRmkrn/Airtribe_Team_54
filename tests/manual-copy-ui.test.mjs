import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute shipped handlers with a synthetic DOM/clipboard only. No browser,
// permissions, personal data, providers, or actual external sharing are used.
const organizerSource = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8')
  .replace(/\nboot\(\);\s*$/, '');
const roomSource = readFileSync(new URL('../public/room/room.js', import.meta.url), 'utf8')
  .replace(/\nif \(!TOKEN\) \{[\s\S]*$/, '');
const link = 'https://example.test/m/synthetic-room-token-0001';
const draft = '  Hi Synthetic Friend!\n\nCoffee? <not markup> & 🍵\n  ';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup({ clipboard, secure = true, legacy = () => false, room = false, promptResult = null } = {}) {
  const timers = [], elements = [], ids = new Map();
  let document;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
      this.textContent = ''; this.value = ''; this.className = ''; this.parentNode = null;
      elements.push(this);
    }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    after(child) {
      child.parentNode = this.parentNode;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, child);
    }
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    focus() { document.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase()) ? [child] : [],
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const node = (id) => {
    if (!ids.has(id)) ids.set(id, document.body.appendChild(new Element(id.includes('btn') ? 'button' : 'div')));
    return ids.get(id);
  };
  document = {
    createElement: (tag) => new Element(tag), getElementById: node,
    querySelectorAll: () => [], execCommand: vi.fn(legacy),
  };
  document.body = new Element('body');
  const button = document.body.appendChild(new Element('button'));
  button.textContent = 'Copy'; button.focus();
  const fetch = vi.fn(() => { throw new Error('Unexpected network access'); });
  const open = vi.fn(() => { throw new Error('Unexpected external app/window'); });
  const prompt = vi.fn(() => promptResult);
  const context = vm.createContext({
    document, navigator: { clipboard }, window: { isSecureContext: secure, open }, fetch, prompt,
    location: { origin: 'https://example.test', pathname: '/m/synthetic-room-token-0001', hash: '#/meetups' },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
  });
  vm.runInContext(room ? roomSource : organizerSource, context);
  context.button = button;
  const run = (script) => vm.runInContext(script, context);
  return {
    button, document, context, timers, elements, fetch, open, prompt, node, run,
    copy(text = draft, label = 'Copy') { context.text = text; context.label = label; return run('copyText(text, button, label)'); },
    panel: () => document.body.querySelector('.copy-fallback'),
    assertLocalOnly() { expect(fetch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(context.location.href).toBeUndefined(); },
  };
}

function expectManual(app, text = draft) {
  expect(app.button.textContent).not.toBe('Copied!');
  const panel = app.panel();
  expect(panel).not.toBeNull();
  const field = panel.querySelector('textarea');
  expect(field.value).toBe(text);
  expect(field.readOnly).toBe(true);
  expect(field.parentNode.tagName).toBe('LABEL');
  expect(field.parentNode.textContent).toContain('Text to copy');
  expect(panel.querySelector('p').getAttribute('role')).toBe('status');
  expect(field.getAttribute('aria-describedby')).toBe(panel.querySelector('p').id);
  expect(panel.querySelector('p').textContent).toContain('Automatic copy');
  expect(app.document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, text.length]);
  expect(app.timers).toHaveLength(0);
  app.assertLocalOnly();
  return panel;
}

describe('organizer manual copy boundaries', () => {
  it.each([
    ['returns false', () => false],
    ['throws', () => { throw new Error('Synthetic legacy denial'); }],
    ['is unavailable', undefined],
  ])('offers exact selectable text without success when legacy copy %s', async (_name, legacy) => {
    const app = setup({ legacy });
    if (!legacy) app.document.execCommand = undefined;
    await app.copy();
    expectManual(app);
    expect(app.document.body.querySelectorAll('textarea')).toHaveLength(1);
  });

  it.each(['rejects', 'throws', 'method missing'])('falls back when secure clipboard %s', async (failure) => {
    const writeText = failure === 'method missing' ? undefined : vi.fn(() => {
      if (failure === 'throws') throw new Error('Synthetic clipboard denial');
      return Promise.reject(new Error('Synthetic clipboard denial'));
    });
    const app = setup({ clipboard: { writeText } });
    await app.copy(link, 'Copy link');
    expectManual(app, link);
  });

  it('reports success only after a fulfilled clipboard write and resets its own label', async () => {
    const pending = deferred(), writeText = vi.fn(() => pending.promise);
    const app = setup({ clipboard: { writeText } });
    const copying = app.copy(draft, 'Copy invite text');
    expect(app.button.textContent).toBe('Copy invite text');
    expect(writeText).toHaveBeenCalledWith(draft);
    pending.resolve(); await copying;
    expect(app.button.textContent).toBe('Copied!');
    expect(app.button.getAttribute('aria-live')).toBe('polite');
    expect(app.document.execCommand).not.toHaveBeenCalled();
    expect(app.panel()).toBeNull();
    expect(app.timers[0].delay).toBe(1500);
    app.timers[0].callback();
    expect(app.button.textContent).toBe('Copy invite text');
    app.assertLocalOnly();
  });

  it.each([true, false])('supports successful legacy copy when secure context is %s', async (secure) => {
    const writeText = vi.fn();
    const app = setup({ secure, clipboard: secure ? undefined : { writeText }, legacy: () => true });
    await app.copy(link, 'Copy link');
    expect(app.document.execCommand).toHaveBeenCalledExactlyOnceWith('copy');
    expect(writeText).not.toHaveBeenCalled();
    expect(app.button.textContent).toBe('Copied!');
    expect(app.document.body.querySelectorAll('textarea')).toHaveLength(0);
    expect(app.document.activeElement).toBe(app.button);
    app.assertLocalOnly();
  });

  it.each(['Close', 'Escape'])('dismisses manual fallback with %s without claiming it copied', async (action) => {
    const app = setup(); await app.copy();
    const panel = expectManual(app);
    if (action === 'Close') panel.querySelector('button').onclick();
    else {
      const preventDefault = vi.fn(); panel.onkeydown({ key: 'Escape', preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(app.panel()).toBeNull();
    expect(app.button.textContent).toBe('Copy');
    expect(app.document.activeElement).toBe(app.button);
    app.assertLocalOnly();
  });

  it('replaces the fallback with the latest edited text and allows a later successful retry', async () => {
    const app = setup(); await app.copy('Old synthetic draft');
    const previous = app.panel(); await app.copy(draft);
    expect(previous.isConnected).toBe(false);
    expectManual(app);
    expect(app.document.body.querySelectorAll('.copy-fallback')).toHaveLength(1);
    app.context.navigator.clipboard = { writeText: vi.fn(async () => {}) };
    await app.copy();
    expect(app.panel()).toBeNull(); expect(app.button.textContent).toBe('Copied!');
    app.assertLocalOnly();
  });

  it.each(['row link', 'created room link', 'invite text'])('uses the real %s handler without sending or opening anything', async (surface) => {
    const app = setup();
    app.button.dataset = { copy: link };
    app.document.querySelectorAll = (selector) => selector === '[data-copy]' ? [app.button] : [];
    app.node('room-url-text').textContent = link;
    const invite = app.document.createElement('div'); invite.textContent = draft;
    app.document.querySelector = () => invite;
    app.run('wireMeetupRows()');
    const button = surface === 'row link' ? app.button : app.node(surface === 'invite text' ? 'copy-invite' : 'copy-room');
    await button.onclick();
    expect(app.panel().querySelector('textarea').value).toBe(surface === 'invite text' ? draft : link);
    expect(button.textContent).toBe(surface === 'invite text' ? 'Copy invite text' : 'Copy link');
    app.assertLocalOnly();
  });

  it('copies current edited check-in text through its real callback, preserving the manual WhatsApp control', async () => {
    const app = setup();
    const create = app.document.createElement;
    const container = app.document.body.appendChild(create('div'));
    const box = create('div');
    const controls = {
      '.draft-text': box.appendChild(create('textarea')), '.draft-copy': box.appendChild(create('button')),
      '.draft-wa': box.appendChild(create('a')), '.draft-again': box.appendChild(create('button')),
    };
    // Supply the rendered controls, not an HTML parser. Execute the production
    // panel load and event bindings with one synthetic draft response.
    box.querySelector = (selector) => controls[selector];
    app.document.createElement = (tag) => tag === 'div' ? box : create(tag);
    app.context.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ message: 'Synthetic original', source: 'template' }) }));
    app.context.container = container;
    app.run("draftPanel(container, 'synthetic-contact', 'Synthetic Friend')");
    await new Promise((resolve) => setImmediate(resolve));
    controls['.draft-text'].value = draft;
    controls['.draft-text'].oninput();
    expect(controls['.draft-wa'].href).toBe('https://wa.me/?text=' + encodeURIComponent(draft));
    app.document.createElement = create;
    await controls['.draft-copy'].onclick({ currentTarget: controls['.draft-copy'] });
    expect(app.panel().querySelector('textarea').value).toBe(draft);
    expect(app.context.fetch).toHaveBeenCalledOnce();
    expect(app.context.fetch.mock.calls[0][0]).toBe('/api/me/contacts/synthetic-contact/draft');
    app.assertLocalOnly();
  });

  it.each(['hash changed', 'generation changed', 'button removed'])('ignores late success and denial after %s', async (navigation) => {
    for (const succeeds of [true, false]) {
      const pending = deferred();
      const app = setup({ clipboard: { writeText: () => pending.promise } });
      const copying = app.copy();
      if (navigation === 'hash changed') app.context.location.hash = '#/contacts';
      if (navigation === 'generation changed') app.run('navGen++');
      if (navigation === 'button removed') app.button.remove();
      succeeds ? pending.resolve() : pending.reject(new Error('Late denial'));
      await copying;
      expect(app.panel()).toBeNull(); expect(app.button.textContent).toBe('Copy');
      expect(app.timers).toHaveLength(0); app.assertLocalOnly();
    }
  });

  it('does not let an older completion or timer overwrite a newer attempt', async () => {
    const pending = deferred(); let count = 0;
    const app = setup({ clipboard: { writeText: () => ++count === 1 ? pending.promise : Promise.resolve() } });
    const first = app.copy('First'); await app.copy('Second', 'Copy latest');
    pending.reject(new Error('Old denial')); await first;
    expect(app.panel()).toBeNull(); expect(app.button.textContent).toBe('Copied!');
    const oldTimer = app.timers[0]; await app.copy('Third', 'Copy third');
    oldTimer.callback(); expect(app.button.textContent).toBe('Copied!');
    app.timers[1].callback(); expect(app.button.textContent).toBe('Copy third');
    app.context.location.hash = '#/contacts'; app.button.textContent = 'New view';
    app.timers[1].callback(); expect(app.button.textContent).toBe('New view');
    app.assertLocalOnly();
  });
});

describe('existing public room copy fallback', () => {
  it.each(['denied', 'unavailable'].flatMap((state) => [null, link].map((result) => [state, result])))('retains the exact guest link prompt when clipboard is %s; prompt result %j is not proof of copying', async (state, promptResult) => {
    const clipboard = state === 'denied' ? { writeText: () => Promise.reject(new Error('Synthetic denial')) } : undefined;
    const app = setup({ room: true, clipboard, promptResult });
    app.node('share-btn').textContent = 'Copy guest link';
    await app.node('share-btn').onclick();
    expect(app.prompt).toHaveBeenCalledExactlyOnceWith('Copy this link:', link);
    expect(app.node('share-btn').textContent).toBe('Copy guest link');
    expect(app.timers).toHaveLength(0); app.assertLocalOnly();
  });

  it('still copies a guest link successfully without opening anything', async () => {
    const writeText = vi.fn(async () => {});
    const app = setup({ room: true, clipboard: { writeText } });
    await app.node('share-btn').onclick();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(link);
    expect(app.node('share-btn').textContent).toBe('Copied!');
    expect(app.prompt).not.toHaveBeenCalled();
    app.timers[0].callback(); expect(app.node('share-btn').textContent).toBe('Copy guest link');
    app.assertLocalOnly();
  });
});
