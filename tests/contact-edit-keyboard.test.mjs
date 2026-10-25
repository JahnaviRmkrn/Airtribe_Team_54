import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8').replace(/\nboot\(\);\s*$/, '');
const contact = { name: 'Alice', category: 'personal', interests: [], notes: '', email: null, preferred_frequency_days: 14 };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup() {
  const nodes = new Map(), focus = [], calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', disabled: false, innerHTML: '', attrs: {},
      focus() { focus.push(id); }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      querySelectorAll() { return id === 'e-form' ? ['e-name', 'e-cat', 'e-notes', 'e-save', 'e-cancel'].map(node) : []; },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ document: { getElementById: node }, window: {}, location: { hash: '#/contacts/one' }, contact,
    save: async (...args) => { calls.push(args); }, reload: async () => {},
  });
  vm.runInContext(source, context);
  vm.runInContext('api = (...args) => save(...args); contactDetailView = async () => { ++navGen; await reload(); }; editContactForm("one", contact);', context);
  for (const [id, value] of Object.entries({ 'e-name': 'Alice', 'e-cat': 'personal', 'e-interests': '', 'e-notes': '', 'e-email': '', 'e-freq': '14', 'e-next': '' })) node(id).value = value;
  const submit = () => node('e-form').onsubmit({ preventDefault() {} });
  return { node, context, focus, calls, submit, change() { node('e-notes').value = 'Changed'; } };
}
describe('contact editor keyboard and pending lifecycle', () => {
  it('renders one semantic form with submit/cancel types, alert/status and initial field focus', () => {
    const app = setup(), html = app.node('profile-card').innerHTML;
    expect(html).toContain('<form id="e-form">');
    expect(html).toContain('id="e-save" type="submit"'); expect(html).toContain('id="e-cancel" type="button"');
    expect(html).toContain('id="e-error" role="alert" tabindex="-1"'); expect(html).toContain('id="e-status" role="status"');
    expect(html).toContain('id="e-name" required'); expect(app.focus).toEqual(['e-name']);
    expect(app.node('c-edit').disabled).toBe(true);
    expect(app.node('log-status').textContent).toContain('Save or cancel');
  });
  it('submits changed fields through the form and returns focus after successful detail reload', async () => {
    const app = setup(); app.change(); await app.submit();
    expect(app.calls).toHaveLength(1); expect(JSON.parse(app.calls[0][1].body)).toEqual({ notes: 'Changed' });
    expect(app.focus).toEqual(['e-name', 'c-edit']);
  });
  it('cancels without saving and restores detail focus', async () => {
    const app = setup(); app.change(); await app.node('e-cancel').onclick();
    expect(app.calls).toEqual([]); expect(app.focus).toEqual(['e-name', 'c-edit']);
  });
  it('returns unchanged form without a PATCH', async () => {
    const app = setup(); await app.submit(); expect(app.calls).toEqual([]); expect(app.focus.at(-1)).toBe('c-edit');
  });
  it('coalesces duplicate submit and ignores cancel while a PATCH is pending', async () => {
    const app = setup(), wait = deferred(); app.context.save = (...args) => { app.calls.push(args); return wait.promise; }; app.change();
    const pending = app.submit(); await app.submit(); await app.node('e-cancel').onclick();
    expect(app.calls).toHaveLength(1); expect(app.node('e-save').disabled).toBe(true); expect(app.node('e-cancel').disabled).toBe(true);
    expect(app.node('e-form').attrs['aria-busy']).toBe('true'); expect(app.node('e-status').textContent).toBe('Saving contact...');
    expect(app.focus).toEqual(['e-name']); wait.resolve(); await pending; expect(app.focus.at(-1)).toBe('c-edit');
  });
  it('retains draft, focuses announced error, and restores controls for retry', async () => {
    const app = setup(); app.change(); app.context.save = async () => { throw new Error('Synthetic failure'); };
    await app.submit(); expect(app.node('e-error').textContent).toBe('Synthetic failure'); expect(app.focus.at(-1)).toBe('e-error');
    expect(app.node('e-notes').value).toBe('Changed'); expect(app.node('e-save').disabled).toBe(false); expect(app.node('e-cancel').disabled).toBe(false);
    expect(app.node('e-form').attrs['aria-busy']).toBeUndefined(); expect(app.node('e-status').textContent).toBe('');
    app.context.save = async () => {}; await app.submit(); expect(app.focus.at(-1)).toBe('c-edit');
  });
  it('announces invalid date without a request and permits correction', async () => {
    const app = setup(); app.node('e-next').value = 'invalid'; await app.submit();
    expect(app.calls).toEqual([]); expect(app.node('e-error').textContent).toBeTruthy(); expect(app.focus.at(-1)).toBe('e-error');
    expect(app.node('e-save').disabled).toBe(false);
  });
  it.each(['success', 'failure'])('ignores stale pending %s after hash navigation before the route event', async (outcome) => {
    const app = setup(), wait = deferred(); app.context.save = () => wait.promise; app.change();
    const pending = app.submit(); app.context.location.hash = '#/dashboard';
    if (outcome === 'failure') wait.reject(new Error('Old error')); else wait.resolve();
    await pending; expect(app.focus).toEqual(['e-name']); expect(app.node('e-error').textContent).toBe('');
  });
  it('does not refocus when detail reload finishes after another navigation', async () => {
    const app = setup(), wait = deferred(); app.context.reload = () => wait.promise;
    const pending = app.node('e-cancel').onclick(); vm.runInContext('++navGen', app.context); wait.resolve(); await pending;
    expect(app.focus).toEqual(['e-name']);
  });
  it('ignores stale submit and cancel after another view takes ownership', async () => {
    const app = setup(); app.change(); vm.runInContext('++navGen', app.context);
    await app.submit(); await app.node('e-cancel').onclick(); expect(app.calls).toEqual([]); expect(app.focus).toEqual(['e-name']);
  });
});
