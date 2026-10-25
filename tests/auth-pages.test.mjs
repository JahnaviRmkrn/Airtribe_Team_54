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
  const context = vm.createContext({
    exports: {}, window, location, URL, URLSearchParams, Error, setTimeout, clearTimeout,
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ external: { google: true } }) }),
    require(id) {
      if (!(id in modules)) throw new Error(`Unexpected page dependency: ${id}`);
      return modules[id];
    },
  });
  vm.runInContext(pages[name], context);
  return {
    client, location, effects, listeners, history,
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
    for (const node of nodes(tree).filter((node) => typeof node.props['aria-pressed'] === 'boolean' || node.props.className === 'magic-toggle')) {
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
    view.auth.onAuthStateChange.mock.calls[0][0]('PASSWORD_RECOVERY');
    await tick();
    expect(nodes(view.render()).some((node) => node.type === 'form')).toBe(true);
    cleanup();
  });

  it.each(['returned', 'rejected'])('allows retry after a %s password-update error', async (kind) => {
    vi.useFakeTimers();
    const view = resetPage();
    if (kind === 'returned') view.auth.updateUser.mockResolvedValueOnce({ error: new Error('Try again later') });
    else view.auth.updateUser.mockRejectedValueOnce(new Error('Try again later'));
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
    cleanup();
    resolve({ error: null });
    await pending;
    await vi.runAllTimersAsync();
    expect(view.location.href).toBe('');
    expect(text(view.render())).not.toContain('Password updated');
  });
});
