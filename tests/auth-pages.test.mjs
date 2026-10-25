import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordAuth } from '../lib/password-auth';
import { safeNext } from '../lib/urls';

// Exercise the actual page handlers and JSX without a browser, credentials, or
// network requests. A small hook harness retains state between explicit renders.
// Production prerendering is also checked by the credential-free Next build.
const pages = Object.fromEntries(['login', 'reset-password'].map((name) => [name,
  ts.transpileModule(readFileSync(new URL(`../app/${name}/page.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText,
]));

function page(name, auth = {}, search = '', env = {}) {
  const state = [];
  const effects = [];
  let cursor = 0;
  let effectCursor = 0;
  const client = vi.fn(() => ({ auth }));
  const location = { origin: 'https://example.test', pathname: '/login', hash: '', search, href: '' };
  const listeners = new Map();
  const history = {
    state: { retained: true },
    replaceState: vi.fn((_state, _title, url) => { location.search = url.search; location.hash = url.hash; }),
  };
  const window = {
    history,
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
  };
  const modules = {
    react: {
      useCallback: (fn) => fn,
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => {
          state[index] = typeof value === 'function' ? value(state[index]) : value;
        }];
      },
      useEffect(effect) {
        const index = effectCursor++;
        if (!(index in effects)) effects[index] = effect;
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = { current: initial };
        return state[index];
      },
    },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: 'fragment',
    },
    'next/link': { default: (props) => ({ type: 'a', props }) },
    '@/lib/supabase/browser': { browserClient: client },
    '@/lib/password-auth': { passwordAuth },
    '@/lib/urls': { safeNext },
    '@/lib/env': { supabaseUrl: () => 'https://example.test', supabaseAnonKey: () => 'test-key', ...env },
    '@vercel/analytics': { track: vi.fn() },
    './login.css': {},
    '../login/login.css': {},
  };
  const request = vi.fn(async (url, options) => {
    if (url === '/api/me/password') {
      const result = await auth.updateUser({ password: JSON.parse(options.body).password });
      return { ok: !result.error, status: result.error ? 400 : 200, json: async () => result.error
        ? { error: result.error.message, code: 'password_update_rejected' } : { updated: true } };
    }
    return { ok: true, json: async () => ({ external: { google: true } }) };
  });
  const context = vm.createContext({
    exports: {}, window, location, URL, URLSearchParams, Error, setTimeout, clearTimeout,
    fetch: request,
    require(id) {
      if (!(id in modules)) throw new Error(`Unexpected page dependency: ${id}`);
      return modules[id];
    },
  });
  vm.runInContext(pages[name], context);
  return {
    client, location, effects, listeners, history, request,
    render() {
      cursor = 0;
      effectCursor = 0;
      return context.exports.default();
    },
  };
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (!tree) return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
const find = (tree, test) => {
  const node = nodes(tree).find(test);
  expect(node, 'Expected page element').toBeDefined();
  return node;
};
const button = (tree, label) => find(tree, (node) => node.type === 'button' && text(node) === label);
const field = (tree, id, value) => find(tree, (node) => node.props.id === id).props.onChange({ target: { value } });
const submit = (tree) => find(tree, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => vi.useRealTimers());

describe('reconciled login design and authentication', () => {
  it.each(['login', 'reset-password'])('renders %s without constructing an auth client', (name) => {
    const view = page(name);
    expect(text(view.render())).toContain('muop');
    expect(view.client).not.toHaveBeenCalled();
  });

  it('makes the login purpose and separate account choice explicit', () => {
    const view = page('login');
    const tree = view.render();
    expect(text(find(tree, (node) => node.type === 'h1'))).toBe('Log in to muop');
    expect(button(tree, 'Log in').props['aria-pressed']).toBe(true);
    expect(button(tree, 'Create account').props['aria-pressed']).toBe(false);
    expect(text(find(tree, (node) => node.props.type === 'submit'))).toContain('Log in');
    expect(find(tree, (node) => node.props.id === 'login-email').props.autoComplete).toBe('email');
    expect(find(tree, (node) => node.props.id === 'login-password').props.autoComplete).toBe('current-password');
    expect(find(tree, (node) => node.props.id === 'login-password').props.required).toBe(true);
    expect(button(tree, 'Forgot password?')).toBeDefined();
  });

  it.each([['signup', 'Create your account'], ['signin', 'Log in to muop'], ['unknown', 'Log in to muop']])(
    'opens the explicit %s entry without starting authentication', (mode, heading) => {
      const view = page('login', {}, `?mode=${mode}&next=%2Forganizer`);
      view.render();
      const cleanup = view.effects[1]();
      expect(text(find(view.render(), (node) => node.type === 'h1'))).toBe(heading);
      expect(view.client).not.toHaveBeenCalled();
      cleanup();
      expect(view.listeners.has('popstate')).toBe(false);
    },
  );

  it('keeps the selected mode and safe return path when toggling or revisiting login', () => {
    const view = page('login', {}, '?next=%2Forganizer&error=auth');
    view.render();
    const cleanup = view.effects[1]();
    button(view.render(), 'Create account').props.onClick();
    expect(text(find(view.render(), (node) => node.type === 'h1'))).toBe('Create your account');
    expect(find(view.render(), (node) => node.props.id === 'login-password').props.autoComplete).toBe('new-password');
    expect(view.location.search).toBe('?next=%2Forganizer&error=auth&mode=signup');
    expect(view.history.replaceState).toHaveBeenLastCalledWith(view.history.state, '', expect.any(URL));
    button(view.render(), 'Log in').props.onClick();
    expect(view.location.search).toBe('?next=%2Forganizer&error=auth');
    view.location.search = '?mode=signup&next=%2Forganizer';
    view.listeners.get('popstate')();
    expect(button(view.render(), 'Create account').props['aria-pressed']).toBe(true);
    cleanup();
  });

  it('still toggles password visibility without submitting the form', () => {
    const view = page('login');
    find(view.render(), (node) => node.props['aria-label'] === 'Show password').props.onClick();
    expect(find(view.render(), (node) => node.props.id === 'login-password').props.type).toBe('text');
    find(view.render(), (node) => node.props['aria-label'] === 'Hide password').props.onClick();
    expect(find(view.render(), (node) => node.props.id === 'login-password').props.type).toBe('password');
    expect(view.client).not.toHaveBeenCalled();
  });

  it('uses explicit signup and waits for email confirmation instead of redirecting', async () => {
    const auth = {
      signUp: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signInWithPassword: vi.fn(),
    };
    const view = page('login', auth, '?next=%2Forganizer');
    let tree = view.render();
    button(tree, 'Create account').props.onClick();
    field(tree, 'login-email', ' user@example.test ');
    field(tree, 'login-password', 'password');
    await submit(view.render());
    tree = view.render();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'user@example.test', password: 'password',
      options: { emailRedirectTo: 'https://example.test/auth/callback?next=%2Forganizer' },
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(view.location.href).toBe('');
    expect(text(tree)).toContain('Check your email to confirm your account');
    expect(find(tree, (node) => node.props.type === 'submit').props.disabled).toBe(false);
  });

  it('does not turn a failed sign-in into signup and permits retry', async () => {
    const auth = {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('Invalid credentials') }),
      signUp: vi.fn(),
    };
    const view = page('login', auth);
    const tree = view.render();
    field(tree, 'login-email', 'user@example.test');
    field(tree, 'login-password', 'wrong-password');
    await submit(view.render());
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(view.location.href).toBe('');
    expect(text(view.render())).toContain('Invalid credentials');
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(false);
  });

  it.each([
    ['%2Forganizer', '/organizer'],
    ['https%3A%2F%2Fevil.test', '/'],
    ['https%3A%2F%2Fexample.test%2F%2Fevil.test', '/'],
    ['%2F.%2F%2Fevil.test', '/'],
  ])(
    'redirects a real session only to a safe next path (%s)', async (next, expected) => {
      const auth = { signInWithPassword: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }) };
      const view = page('login', auth, `?next=${next}`);
      const tree = view.render();
      field(tree, 'login-email', 'user@example.test');
      field(tree, 'login-password', 'password');
      await submit(view.render());
      expect(view.location.href).toBe(expected);
    },
  );

  it.each([['signin', false], ['signup', true]])('keeps magic-link account creation explicit in %s mode', async (mode, shouldCreateUser) => {
    const auth = { signInWithOtp: vi.fn().mockResolvedValue({ error: null }) };
    const view = page('login', auth, '?next=%2Forganizer');
    const tree = view.render();
    if (mode === 'signup') button(tree, 'Create account').props.onClick();
    find(tree, (node) => node.props.className === 'magic-toggle').props.onClick();
    field(tree, 'login-email', 'user@example.test');
    await submit(view.render());
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'user@example.test',
      options: { emailRedirectTo: 'https://example.test/auth/callback?next=%2Forganizer', shouldCreateUser },
    });
    expect(text(view.render())).toContain('Check your email for a sign-in link.');
  });

  it('sends only one magic link for repeated submissions before React rerenders', async () => {
    let resolve;
    const auth = { signInWithOtp: vi.fn(() => new Promise((done) => { resolve = done; })) };
    const view = page('login', auth);
    find(view.render(), (node) => node.props.className === 'magic-toggle').props.onClick();
    field(view.render(), 'login-email', 'alice@example.test');
    const form = view.render();
    const first = submit(form);
    const repeated = submit(form);
    expect(auth.signInWithOtp).toHaveBeenCalledOnce();
    expect(find(view.render(), (node) => node.props.id === 'login-email').props.disabled).toBe(true);
    field(form, 'login-email', 'bob@example.test');
    button(form, 'Create account').props.onClick();
    find(form, (node) => node.props.className === 'magic-toggle').props.onClick();
    expect(find(view.render(), (node) => node.props.id === 'login-email').props.value).toBe('alice@example.test');
    expect(button(view.render(), 'Log in').props['aria-pressed']).toBe(true);
    expect(text(view.render())).toContain('MAGIC LINK');
    resolve({ error: null });
    await Promise.all([first, repeated]);
    expect(find(view.render(), (node) => node.props.id === 'login-email').props.disabled).toBe(false);
    expect(text(view.render())).toContain('latest link in this browser');
  });

  it('does not start another auth method from a stale control while a magic link is pending', async () => {
    let resolve;
    const auth = {
      signInWithOtp: vi.fn(() => new Promise((done) => { resolve = done; })),
      signInWithOAuth: vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    };
    const view = page('login', auth);
    field(view.render(), 'login-email', 'alice@example.test');
    field(view.render(), 'login-password', 'fixture-password');
    const passwordForm = view.render();
    find(passwordForm, (node) => node.props.className === 'magic-toggle').props.onClick();
    const magicForm = view.render();
    const pending = submit(magicForm);
    await submit(passwordForm);
    await button(passwordForm, 'Forgot password?').props.onClick();
    await find(magicForm, (node) => node.props['data-provider'] === 'google').props.onClick();
    expect(auth.signInWithOtp).toHaveBeenCalledOnce();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
    resolve({ error: null });
    await pending;
  });

  it('replaces an expired callback error with a success status when a new magic link is requested', async () => {
    const auth = { signInWithOtp: vi.fn().mockResolvedValue({ error: null }) };
    const view = page('login', auth, '?error=auth');
    view.render();
    view.effects[2]();
    expect(find(view.render(), (node) => node.props.role === 'alert')).toBeDefined();
    find(view.render(), (node) => node.props.className === 'magic-toggle').props.onClick();
    field(view.render(), 'login-email', 'alice@example.test');
    await submit(view.render());
    expect(find(view.render(), (node) => node.props.role === 'status').props.className).toBe('login-msg info');
    expect(nodes(view.render()).some((node) => node.props.role === 'alert')).toBe(false);
  });

  it('clears a sent-link notice before changing the email or choosing another sign-in method', async () => {
    const auth = { signInWithOtp: vi.fn().mockResolvedValue({ error: null }) };
    const view = page('login', auth);
    find(view.render(), (node) => node.props.className === 'magic-toggle').props.onClick();
    field(view.render(), 'login-email', 'alice@example.test');
    await submit(view.render());
    field(view.render(), 'login-email', 'bob@example.test');
    expect(text(view.render())).not.toContain('Check your email');
    expect(view.location.href).toBe('');
    await submit(view.render());
    expect(auth.signInWithOtp.mock.calls[1][0].email).toBe('bob@example.test');
    find(view.render(), (node) => node.props.className === 'magic-toggle').props.onClick();
    expect(text(view.render())).not.toContain('Check your email');
    expect(auth.signInWithOtp).toHaveBeenCalledTimes(2);
  });

  it('sends forgotten-password recovery through the new reset page', async () => {
    const auth = { resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }) };
    const view = page('login', auth);
    field(view.render(), 'login-email', 'user@example.test');
    await button(view.render(), 'Forgot password?').props.onClick();
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('user@example.test', {
      redirectTo: 'https://example.test/auth/callback?next=%2Freset-password',
    });
    expect(text(view.render())).toContain('Check your email for a password reset link.');
  });

  it('disables mode changes while a password request is pending', async () => {
    let resolve;
    const auth = { signInWithPassword: vi.fn(() => new Promise((done) => { resolve = done; })) };
    const view = page('login', auth);
    field(view.render(), 'login-email', 'user@example.test');
    field(view.render(), 'login-password', 'password');
    const pending = submit(view.render());
    const tree = view.render();
    for (const node of nodes(tree).filter((node) => node.type === 'input' || typeof node.props['aria-pressed'] === 'boolean' || node.props.className === 'magic-toggle')) {
      expect(node.props.disabled).toBe(true);
    }
    resolve({ data: { session: null }, error: null });
    await pending;
  });

  it.each(['oauth', 'magic', 'forgot'])('recovers from a rejected %s request and allows retry', async (kind) => {
    const method = { oauth: 'signInWithOAuth', magic: 'signInWithOtp', forgot: 'resetPasswordForEmail' }[kind];
    const request = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue({ error: null });
    const view = page('login', { [method]: request });
    field(view.render(), 'login-email', 'user@example.test');
    if (kind === 'magic') find(view.render(), (node) => node.props.className === 'magic-toggle').props.onClick();
    const action = () => kind === 'magic' ? submit(view.render())
      : kind === 'forgot' ? button(view.render(), 'Forgot password?').props.onClick()
        : find(view.render(), (node) => node.props['data-provider'] === 'google').props.onClick();
    await action();
    expect(text(view.render())).toContain('Network unavailable');
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(false);
    await action();
    expect(request).toHaveBeenCalledTimes(2);
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(kind === 'oauth');
  });

  it('recovers from missing client configuration without leaving the form busy', async () => {
    const view = page('login');
    field(view.render(), 'login-email', 'user@example.test');
    view.client.mockImplementationOnce(() => { throw new Error('Auth configuration unavailable'); });
    await button(view.render(), 'Forgot password?').props.onClick();
    expect(text(view.render())).toContain('Auth configuration unavailable');
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(false);
  });

  it('keeps login usable when optional provider discovery has no configuration', async () => {
    const view = page('login', {}, '', { supabaseUrl: () => { throw new Error('Missing configuration'); } });
    view.render();
    expect(() => view.effects[0]()).not.toThrow();
    await tick();
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(false);
    expect(view.client).not.toHaveBeenCalled();
  });
});

function resetPage(hasSession = true, search = '') {
  const unsubscribe = vi.fn();
  const auth = {
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe } } })),
    getUser: vi.fn().mockResolvedValue({ data: { user: hasSession ? { id: 'test-user' } : null }, error: null }),
    updateUser: vi.fn().mockResolvedValue({ error: null }),
  };
  return { ...page('reset-password', auth, search), auth, unsubscribe };
}

describe('preserved reset-password flow', () => {
  it('does not update a different account after the ready reset form switches owner', async () => {
    vi.useFakeTimers();
    const view = resetPage();
    view.render();
    const cleanup = view.effects[0]();
    await tick();
    field(view.render(), 'reset-password', 'new-password');
    field(view.render(), 'reset-confirm', 'new-password');
    const oldForm = view.render();
    view.auth.getUser.mockResolvedValue({ data: { user: { id: 'different-user' } }, error: null });
    view.auth.onAuthStateChange.mock.calls[0][0]('SIGNED_IN', { user: { id: 'different-user' } });
    await submit(oldForm);
    expect(view.auth.updateUser).not.toHaveBeenCalled();
    expect(text(view.render())).toContain('account changed');
    cleanup();
  });

  it('rejects an expired link without offering a password update', async () => {
    const view = resetPage(false);
    view.render();
    const cleanup = view.effects[0]();
    await tick();
    expect(text(view.render())).toContain('This reset link is invalid or has expired.');
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(false);
    expect(view.auth.updateUser).not.toHaveBeenCalled();
    cleanup();
    expect(view.unsubscribe).toHaveBeenCalledOnce();
  });

  it('validates both password entries before updating the user', async () => {
    const view = resetPage();
    view.render();
    view.effects[0]();
    await tick();
    field(view.render(), 'reset-password', 'short');
    field(view.render(), 'reset-confirm', 'short');
    await submit(view.render());
    expect(text(view.render())).toContain('Password must be at least 6 characters.');
    field(view.render(), 'reset-password', 'new-password');
    field(view.render(), 'reset-confirm', 'not-matching');
    await submit(view.render());
    expect(text(view.render())).toContain('Passwords do not match.');
    expect(view.auth.updateUser).not.toHaveBeenCalled();
  });

  it.each(['https://evil.test', 'https://example.test//evil.test', '/.//evil.test'])(
    'updates a confirmed password and rejects unsafe return URL %s', async (next) => {
    vi.useFakeTimers();
    const view = resetPage(true, '?next=' + encodeURIComponent(next));
    view.render();
    view.effects[0]();
    await tick();
    field(view.render(), 'reset-password', 'new-password');
    field(view.render(), 'reset-confirm', 'new-password');
    await submit(view.render());
    expect(view.auth.updateUser).toHaveBeenCalledExactlyOnceWith({ password: 'new-password' });
    expect(text(view.render())).toContain('Password updated');
    await vi.runAllTimersAsync();
    expect(view.location.href).toBe('/');
  });

  it.each(['client', 'request'])('exits checking on a failed verification %s', async (kind) => {
    const view = resetPage();
    view.render();
    if (kind === 'client') view.client.mockImplementationOnce(() => { throw new Error('Missing configuration'); });
    else view.auth.getUser.mockRejectedValueOnce(new Error('Offline'));
    const cleanup = view.effects[0]();
    await tick();
    expect(text(view.render())).toContain('Please refresh the page to try again.');
    expect(text(view.render())).not.toContain('Checking your reset link');
    expect(view.auth.updateUser).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not overwrite a recovery event with a late verification failure', async () => {
    const view = resetPage();
    view.auth.getUser.mockRejectedValueOnce(new Error('Offline'));
    view.render();
    const cleanup = view.effects[0]();
    view.auth.onAuthStateChange.mock.calls[0][0]('PASSWORD_RECOVERY', { user: { id: 'test-user' } });
    await tick();
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(true);
    cleanup();
  });

  it('allows retry after an explicitly rejected password update', async () => {
    vi.useFakeTimers();
    const view = resetPage();
    view.auth.updateUser.mockResolvedValueOnce({ error: new Error('Try again later') });
    view.render();
    const cleanup = view.effects[0]();
    await tick();
    field(view.render(), 'reset-password', 'new-password');
    field(view.render(), 'reset-confirm', 'new-password');
    await submit(view.render());
    expect(text(view.render())).toContain('Try again later');
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(false);
    await submit(view.render());
    expect(view.auth.updateUser).toHaveBeenCalledTimes(2);
    expect(text(view.render())).toContain('Password updated');
    cleanup();
    await vi.runAllTimersAsync();
    expect(view.location.href).toBe('');
  });

  it('does not schedule a redirect when an update finishes after leaving the page', async () => {
    vi.useFakeTimers();
    const view = resetPage();
    let resolve;
    view.auth.updateUser.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    view.render();
    const cleanup = view.effects[0]();
    await tick();
    field(view.render(), 'reset-password', 'new-password');
    field(view.render(), 'reset-confirm', 'new-password');
    const pending = submit(view.render());
    await tick();
    cleanup();
    resolve({ error: null });
    await pending;
    await vi.runAllTimersAsync();
    expect(view.location.href).toBe('');
    expect(text(view.render())).not.toContain('Password updated');
  });
});

describe('owner-bound reset submission lifecycle', () => {
  async function ready() {
    const view = resetPage();
    view.render();
    const cleanup = view.effects[0]();
    await tick();
    field(view.render(), 'reset-password', 'new-password');
    field(view.render(), 'reset-confirm', 'new-password');
    return { view, cleanup };
  }

  it('sends the owner header to the app route and does not use browser updateUser directly', async () => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    await submit(view.render());
    expect(view.request).toHaveBeenCalledExactlyOnceWith('/api/me/password', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Contact-Owner': 'test-user' },
      body: JSON.stringify({ password: 'new-password' }),
    });
    const pageSource = readFileSync(new URL('../app/reset-password/page.tsx', import.meta.url), 'utf8');
    expect(pageSource).not.toContain('.auth.updateUser(');
    cleanup();
  });

  it('rejects a silent cookie-owner change found at preflight', async () => {
    const { view, cleanup } = await ready();
    view.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'bob' } }, error: null });
    await submit(view.render());
    expect(view.request).not.toHaveBeenCalled();
    expect(text(view.render())).toContain('account changed');
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(false);
    cleanup();
  });

  it('rejects duplicate submits before preflight and while the update is pending', async () => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    let resolve;
    view.auth.updateUser.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const form = view.render();
    const pending = submit(form);
    await submit(form);
    await tick();
    await submit(form);
    expect(view.request).toHaveBeenCalledOnce();
    expect(find(view.render(), (node) => node.props.type === 'submit').props.disabled).toBe(true);
    resolve({ error: null });
    await pending;
    await submit(form);
    expect(view.request).toHaveBeenCalledOnce();
    cleanup();
  });

  it.each(['SIGNED_IN', 'SIGNED_OUT'])('ignores late successful updates after %s changes the session', async (event) => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    let resolve;
    view.auth.updateUser.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = submit(view.render());
    await tick();
    view.auth.onAuthStateChange.mock.calls[0][0](event, event === 'SIGNED_OUT' ? null : { user: { id: 'bob' } });
    resolve({ error: null });
    await pending;
    await vi.runAllTimersAsync();
    expect(text(view.render())).not.toContain('Password updated');
    expect(view.location.href).toBe('');
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(false);
    cleanup();
  });

  it('ignores delayed success after a silent cookie owner switch with no auth event', async () => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    let resolve;
    view.auth.updateUser.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = submit(view.render());
    await tick();
    view.auth.getUser.mockResolvedValue({ data: { user: { id: 'bob' } }, error: null });
    resolve({ error: null });
    await pending;
    await vi.runAllTimersAsync();
    expect(text(view.render())).not.toContain('Password updated');
    expect(text(view.render())).toContain('account changed');
    expect(view.location.href).toBe('');
    expect(view.request).toHaveBeenCalledOnce();
    cleanup();
  });

  it('cancels the delayed redirect when cookies silently switch after the success check', async () => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    await submit(view.render());
    expect(text(view.render())).toContain('Password updated');
    view.auth.getUser.mockResolvedValue({ data: { user: { id: 'bob' } }, error: null });
    await vi.runAllTimersAsync();
    expect(text(view.render())).not.toContain('Password updated');
    expect(text(view.render())).toContain('account changed');
    expect(view.location.href).toBe('');
    expect(view.request).toHaveBeenCalledOnce();
    cleanup();
  });

  it.each(['after update', 'before redirect'])('fails closed when owner verification fails %s without resending', async (stage) => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    if (stage === 'after update') {
      view.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'test-user' } }, error: null })
        .mockRejectedValueOnce(new Error('Verification unavailable'));
    }
    const form = view.render();
    await submit(form);
    if (stage === 'before redirect') view.auth.getUser.mockRejectedValueOnce(new Error('Verification unavailable'));
    await vi.runAllTimersAsync();
    expect(text(view.render())).toContain('Sign in again');
    expect(text(view.render())).not.toContain('Password updated');
    expect(view.location.href).toBe('');
    await submit(form);
    expect(view.request).toHaveBeenCalledOnce();
    cleanup();
  });

  it('preserves a same-owner success and redirect with exactly one password update', async () => {
    vi.useFakeTimers();
    const { view, cleanup } = await ready();
    const form = view.render();
    await submit(form);
    expect(text(view.render())).toContain('Password updated');
    await vi.runAllTimersAsync();
    expect(view.location.href).toBe('/');
    expect(view.auth.getUser).toHaveBeenCalledTimes(4); // Mount, preflight, success, redirect.
    await submit(form);
    expect(view.request).toHaveBeenCalledOnce();
    cleanup();
  });

  it.each(['transport', 'provider'])('locks an uncertain %s result rather than resubmitting automatically', async (kind) => {
    const { view, cleanup } = await ready();
    if (kind === 'transport') view.request.mockRejectedValueOnce(new Error('Response lost'));
    else view.request.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ code: 'password_update_uncertain' }) });
    const form = view.render();
    await submit(form);
    expect(text(view.render())).toContain('Try signing in with the new password');
    await submit(form);
    expect(view.request).toHaveBeenCalledOnce();
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(false);
    cleanup();
  });

  it('shows an explicit setup refusal without claiming an uncertain mutation', async () => {
    const { view, cleanup } = await ready();
    view.request.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'password_update_unavailable', error: 'Public URL configuration is unavailable.' }) });
    await submit(view.render());
    expect(text(view.render())).toContain('Public URL configuration is unavailable.');
    expect(text(view.render())).not.toContain('whether your password changed');
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(false);
    cleanup();
  });

  it.each(['password_owner_changed', 'password_session_expired'])('requires a fresh sign-in/reset after server %s', async (code) => {
    const { view, cleanup } = await ready();
    view.request.mockResolvedValueOnce({ ok: false, status: code === 'password_owner_changed' ? 409 : 401, json: async () => ({ code }) });
    const form = view.render();
    await submit(form);
    await submit(form);
    expect(view.request).toHaveBeenCalledOnce();
    expect(text(view.render())).toContain(code === 'password_owner_changed' ? 'account changed' : 'Sign in again');
    cleanup();
  });
});
