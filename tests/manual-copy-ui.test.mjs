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
      this.disabled = false;
      elements.push(this);
    }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    after(child) {
      child.parentNode = this.parentNode;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, child);
    }
    remove() {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    // Native disabled controls cannot receive focus; removing the focused
    // element (or its ancestor) returns focus to the document body.
    focus() { if (!this.disabled && this.isConnected) document.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
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
    expect(app.button.disabled).toBe(true);
    expect(app.button.getAttribute('aria-busy')).toBe('true');
    expect(writeText).toHaveBeenCalledWith(draft);
    pending.resolve(); await copying;
    expect(app.button.textContent).toBe('Copied!');
    expect(app.button.disabled).toBe(false);
    expect(app.button.getAttribute('aria-busy')).toBeUndefined();
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

  it('does not steal focus on modern clipboard completion after the user moved elsewhere', async () => {
    const pending = deferred();
    const app = setup({ clipboard: { writeText: () => pending.promise } });
    const copying = app.copy();
    const other = app.document.body.appendChild(app.document.createElement('button'));
    other.focus();
    // Focusing the temporarily disabled copy button must have no effect.
    app.button.focus(); expect(app.document.activeElement).toBe(other);
    pending.resolve(); await copying;
    expect(app.button.disabled).toBe(false);
    expect(app.document.activeElement).toBe(other);
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
      if (succeeds) pending.resolve();
      else pending.reject(new Error('Late denial'));
      await copying;
      expect(app.panel()).toBeNull(); expect(app.button.textContent).toBe('Copy');
      expect(app.button.disabled).toBe(false);
      expect(app.button.getAttribute('aria-busy')).toBeUndefined();
      expect(app.timers).toHaveLength(0); app.assertLocalOnly();
    }
  });

  it('blocks duplicate writes from one button and does not let an older timer overwrite a later copy', async () => {
    const pending = deferred();
    const writeText = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const app = setup({ clipboard: { writeText } });
    const first = app.copy('First'); await app.copy('Second', 'Copy latest');
    expect(writeText).toHaveBeenCalledExactlyOnceWith('First');
    expect(app.button.disabled).toBe(true);
    pending.resolve(); await first;
    expect(app.panel()).toBeNull(); expect(app.button.textContent).toBe('Copied!');
    const oldTimer = app.timers[0]; await app.copy('Third', 'Copy third');
    expect(writeText).toHaveBeenCalledTimes(2); expect(writeText).toHaveBeenLastCalledWith('Third');
    oldTimer.callback(); expect(app.button.textContent).toBe('Copied!');
    app.timers[1].callback(); expect(app.button.textContent).toBe('Copy third');
    app.context.location.hash = '#/contacts'; app.button.textContent = 'New view';
    app.timers[1].callback(); expect(app.button.textContent).toBe('New view');
    app.assertLocalOnly();
  });

  it('restores the button after a denied pending write so edited text can be retried', async () => {
    const pending = deferred();
    const writeText = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const app = setup({ clipboard: { writeText } });
    const first = app.copy('Original'); await app.copy(draft);
    expect(writeText).toHaveBeenCalledOnce();
    pending.reject(new Error('Synthetic denial')); await first;
    expectManual(app, 'Original'); expect(app.button.disabled).toBe(false);
    await app.copy(draft);
    expect(writeText).toHaveBeenCalledTimes(2); expect(writeText).toHaveBeenLastCalledWith(draft);
    expect(app.panel()).toBeNull(); expect(app.button.textContent).toBe('Copied!');
    app.assertLocalOnly();
  });

  it('does not start a clipboard write from a removed or disabled control', async () => {
    const writeText = vi.fn(async () => {});
    const app = setup({ clipboard: { writeText } });
    app.button.disabled = true; await app.copy();
    app.button.disabled = false; app.button.remove(); await app.copy();
    expect(writeText).not.toHaveBeenCalled(); expect(app.timers).toHaveLength(0);
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

// Minimal draft markup adapter: execute the shipped draftPanel and copyText,
// while the API and DOM parsing are synthetic and never touch the clipboard.
async function draftEditor(clipboard) {
  const app = setup({ clipboard });
  const create = app.document.createElement;
  app.document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'div') Object.defineProperty(element, 'innerHTML', { set(html) {
      this.children.slice().forEach((child) => child.remove());
      if (!html.includes('class="draft-text"')) return;
      for (const [kind, className] of [['textarea', 'draft-text'], ['a', 'draft-wa'], ['button', 'draft-copy'], ['button', 'draft-again']]) {
        const child = create(kind); child.className = className; this.appendChild(child);
        if (kind === 'textarea') child.value = draft;
        if (className === 'draft-copy') child.textContent = 'Copy';
      }
    } });
    return element;
  };
  const container = app.document.body.appendChild(create('div'));
  app.context.container = container; app.context.draftValue = draft;
  app.run('api = async () => ({ message: draftValue, source: "template", basis: [] }); draftPanel(container, "synthetic-contact", "Synthetic");');
  await Promise.resolve(); await Promise.resolve();
  const text = container.querySelector('.draft-text'), button = container.querySelector('.draft-copy');
  return { ...app, text, button, container,
    edit(value) { text.focus(); text.value = value; text.oninput(); },
    submit() { return button.onclick({ currentTarget: button }); },
  };
}

describe('editable draft copy feedback revisions', () => {
  it.each(['resolve', 'reject'])('suppresses stale %s feedback after edit while retaining the pending lock', async (outcome) => {
    const wait = deferred(), writeText = vi.fn(() => wait.promise), app = await draftEditor({ writeText });
    const pending = app.submit(); app.edit('Edited synthetic draft'); await app.submit();
    expect(writeText).toHaveBeenCalledTimes(1); expect(writeText).toHaveBeenCalledWith(draft);
    expect(app.button.disabled).toBe(true); expect(app.button.getAttribute('aria-busy')).toBe('true');
    if (outcome === 'resolve') wait.resolve(); else wait.reject(new Error('Synthetic denial'));
    await pending;
    expect(app.button.textContent).toBe('Copy'); expect(app.button.disabled).toBe(false);
    expect(app.button.getAttribute('aria-busy')).toBeUndefined(); expect(app.panel()).toBeNull();
    expect(app.document.activeElement).toBe(app.text); expect(app.text.value).toBe('Edited synthetic draft');
    expect(app.timers).toHaveLength(0); app.assertLocalOnly();
  });
  it('invalidates edit then revert, even though text equals the original snapshot again', async () => {
    const wait = deferred(), app = await draftEditor({ writeText: () => wait.promise });
    const pending = app.submit(); app.edit('Changed'); app.edit(draft); wait.resolve(); await pending;
    expect(app.button.textContent).toBe('Copy'); expect(app.panel()).toBeNull(); expect(app.timers).toHaveLength(0);
  });
  it('copies the edited value only on a deliberate later activation after settlement', async () => {
    const wait = deferred(), writeText = vi.fn().mockReturnValueOnce(wait.promise).mockResolvedValueOnce(undefined);
    const app = await draftEditor({ writeText });
    const pending = app.submit(); app.edit('New content'); wait.resolve(); await pending;
    expect(writeText).toHaveBeenCalledTimes(1); await app.submit();
    expect(writeText.mock.calls.map(([text]) => text)).toEqual([draft, 'New content']);
    expect(app.button.textContent).toBe('Copied!');
  });
  it('clears completed success feedback and its timer when the draft changes', async () => {
    const app = await draftEditor({ writeText: async () => {} }); await app.submit();
    expect(app.button.textContent).toBe('Copied!'); const timer = app.timers[0]; app.edit('Changed after copy');
    expect(app.button.textContent).toBe('Copy'); expect(timer.cancelled).toBe(true);
    timer.callback(); expect(app.button.textContent).toBe('Copy');
  });
  it('removes old manual-copy fallback on edit and preserves the editor focus', async () => {
    const app = await draftEditor({ writeText: async () => { throw new Error('Denied'); } }); await app.submit();
    expect(app.panel().querySelector('textarea').value).toBe(draft);
    app.edit('Corrected'); expect(app.panel()).toBeNull(); expect(app.document.activeElement).toBe(app.text);
    await app.submit(); expect(app.panel().querySelector('textarea').value).toBe('Corrected');
  });
  it.each(['resolve', 'reject'])('suppresses pending %s after editing and navigation', async (outcome) => {
    const wait = deferred(), app = await draftEditor({ writeText: () => wait.promise });
    const pending = app.submit(); app.edit('New'); app.context.location.hash = '#/contacts';
    if (outcome === 'resolve') wait.resolve(); else wait.reject(new Error('Denied'));
    await pending; expect(app.button.textContent).toBe('Copy'); expect(app.panel()).toBeNull(); expect(app.button.disabled).toBe(false);
  });
  it.each(['resolve', 'reject'])('preserves unchanged-draft %s behavior', async (outcome) => {
    const wait = deferred(), app = await draftEditor({ writeText: () => wait.promise });
    const pending = app.submit(); if (outcome === 'resolve') wait.resolve(); else wait.reject(new Error('Denied'));
    await pending;
    if (outcome === 'resolve') expect(app.button.textContent).toBe('Copied!');
    else expect(app.panel().querySelector('textarea').value).toBe(draft);
    app.assertLocalOnly();
  });
});
