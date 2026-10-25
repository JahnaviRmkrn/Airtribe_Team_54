import assert from 'node:assert/strict';
import vm from 'node:vm';

// Deterministic DOM-shaped unit checks, not claims about browser/CUA behavior.
export function checkNavigationAdapter(source) {
  const listeners = new Map(), nodes = [], opens = [];
  let observer;
  const node = (tagName, attrs = {}) => {
    const attributes = new Map(Object.entries(attrs));
    const value = { tagName, textContent: '', children: [], getAttribute: key => attributes.get(key) ?? null,
      hasAttribute: key => attributes.has(key), setAttribute: (key, val) => attributes.set(key, val), removeAttribute: key => attributes.delete(key),
      matches: () => ['A', 'FORM'].includes(tagName) || attributes.has('formaction'),
      querySelectorAll: () => value.children, closest: () => value,
    };
    nodes.push(value); return value;
  };
  const existing = node('A', { href: 'https://docs.google.com/spreadsheets/d/synthetic/edit', target: '_blank' });
  const local = node('A', { href: '/organizer/#/contacts', target: '_self' });
  const form = node('FORM', { action: 'https://example.test/', target: '_top' });
  const document = { readyState: 'complete', documentElement: {}, body: { prepend() {} },
    createElement: tag => node(tag.toUpperCase()), querySelectorAll: () => [...nodes], addEventListener: (name, callback) => listeners.set(name, callback) };
  const window = { open: (...args) => { opens.push(args); return 'local-window'; } };
  vm.runInNewContext(source, { document, window, URL,
    location: { href: 'http://127.0.0.1:4323/organizer/', origin: 'http://127.0.0.1:4323' },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
  });
  assert.equal(existing.getAttribute('href'), '/__harness/blocked-navigation');
  assert.equal(existing.getAttribute('target'), null);
  assert.equal(form.getAttribute('action'), '/__harness/blocked-navigation'); assert.equal(form.getAttribute('target'), null);
  assert.equal(local.getAttribute('href'), '/organizer/#/contacts'); assert.equal(local.getAttribute('target'), '_self');
  const event = (target, submitter) => ({ target, submitter, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  for (const type of ['click', 'auxclick', 'submit']) {
    const current = event(type === 'submit' ? form : existing); listeners.get(type)(current);
    assert.equal(current.prevented, true); assert.equal(current.stopped, true);
  }
  const internal = event(local); listeners.get('click')(internal); assert.equal(internal.prevented, false);
  const dynamic = node('A', { href: '//outside.example.test/new', target: 'named-window' });
  observer([{ type: 'childList', addedNodes: [dynamic] }]);
  assert.equal(dynamic.getAttribute('href'), '/__harness/blocked-navigation'); assert.equal(dynamic.getAttribute('target'), null);
  local.setAttribute('href', 'javascript:alert(1)'); observer([{ type: 'attributes', target: local }]);
  assert.equal(local.getAttribute('href'), '/__harness/blocked-navigation');
  const submitter = node('BUTTON', { formaction: 'https://outside.example.test/', formtarget: '_blank' });
  const submitted = event(node('FORM', { action: '/__harness/role' }), submitter); listeners.get('submit')(submitted);
  assert.equal(submitted.prevented, true); assert.equal(submitter.getAttribute('formtarget'), null);
  for (const target of ['_blank', '_self', '_parent', '_top', 'named-window']) assert.equal(window.open('https://outside.example.test/', target), null);
  assert.equal(window.open('/__harness/', '_blank'), 'local-window'); assert.equal(opens.length, 1);
  assert.equal(window.__team54FixtureNavigation.counts.blocked_windows, 5);
  assert.equal(window.__team54FixtureNavigation.counts.blocked_activations, 4);
  assert.equal(window.__team54FixtureNavigation.counts.neutralized_links, 3);
  assert.equal(window.__team54FixtureNavigation.counts.neutralized_forms, 2);
  assert.equal(JSON.stringify(window.__team54FixtureNavigation).includes('outside'), false);
}
