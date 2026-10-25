import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Actual component handlers/JSX with synthetic hooks, not a browser/React
// scheduler emulator. No provider, environment-file, or network access.
const source = ts.transpileModule(readFileSync(new URL('../app/m/[token]/PaymentPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function mount(callApi, overrides = {}) {
  const state = [], effects = [];
  let cursor = 0, effectCursor = 0;
  const location = { assign: vi.fn() };
  const modules = {
    react: {
      useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = value; }]; },
      useRef(initial) { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index]; },
      useEffect(effect) { const index = effectCursor++; if (!(index in effects)) effects[index] = effect; },
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  };
  const context = vm.createContext({ exports: {}, location, URL, Error, require: (name) => modules[name] });
  vm.runInContext(source, context);
  const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
  return {
    effects, location,
    render() {
      cursor = 0; effectCursor = 0;
      const tree = context.exports.default({ callApi, closed: false, price: 500, ...overrides });
      const elements = nodes(tree);
      const buttons = elements.filter((node) => node.type === 'button');
      return { pay: buttons[0].props, check: buttons[1].props, status: elements.find((node) => node.props?.role === 'status').props.children };
    },
  };
}
const ready = { status: 'pending', amount_paise: 50000, redirect_url: 'https://pay.example/A', checkout_state: 'ready' };

async function loaded(api, overrides) {
  const panel = mount(api, overrides);
  panel.render();
  const cleanup = panel.effects[0]();
  await flush();
  return { panel, cleanup };
}

describe('React payment reconciliation controls', () => {
  it.each(['creating', 'reconciliation_required'])('shows and blocks a %s attempt but leaves status checking available', async checkout_state => {
    const api = vi.fn().mockResolvedValue({ checkout_availability: 'ready', payment: { ...ready, redirect_url: null, checkout_state } });
    const { panel } = await loaded(api);
    const ui = panel.render();
    expect(ui.pay.disabled).toBe(true);
    expect(ui.check.disabled).toBe(false);
    expect(ui.status).toMatch(/do not start|Do not pay again/);
    await ui.pay.onClick();
    expect(api).toHaveBeenCalledTimes(1);
    expect(panel.location.assign).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'])('blocks a %s retry even from a mixed-version ready response', async status => {
    const api = vi.fn().mockResolvedValue({ checkout_availability: 'ready', payment: { ...ready, status, redirect_url: null } });
    const { panel } = await loaded(api);
    expect(panel.render().pay.disabled).toBe(true);
    expect(panel.render().status).toContain('needs reconciliation');
    expect(panel.render().status).toContain('Do not pay again');
    await panel.render().pay.onClick();
    expect(api).toHaveBeenCalledTimes(1);
    await panel.render().check.onClick();
    expect(api).toHaveBeenCalledTimes(2);
    expect(panel.location.assign).not.toHaveBeenCalled();
  });

  it('requires status reconciliation after a lost POST response without automatically redirecting', async () => {
    const api = vi.fn().mockResolvedValueOnce({ checkout_availability: 'ready', payment: null }).mockRejectedValueOnce(new Error('Synthetic response loss'));
    const { panel } = await loaded(api);
    await panel.render().pay.onClick();
    expect(panel.render().pay.disabled).toBe(true);
    await panel.render().pay.onClick();
    expect(api).toHaveBeenCalledTimes(2);
    api.mockResolvedValue({ checkout_availability: 'ready', payment: ready });
    await panel.render().check.onClick();
    expect(panel.render().pay.disabled).toBe(false);
    expect(panel.location.assign).not.toHaveBeenCalled();
    await panel.render().pay.onClick();
    expect(panel.location.assign).toHaveBeenCalledWith(ready.redirect_url);
  });

  it('uses the immediate ref lock to prevent duplicate clicks before re-render', async () => {
    let finish;
    const api = vi.fn().mockResolvedValueOnce({ checkout_availability: 'ready', payment: null }).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { panel } = await loaded(api);
    const button = panel.render().pay;
    const pending = button.onClick();
    await button.onClick();
    expect(api).toHaveBeenCalledTimes(2);
    finish({ checkout_availability: 'ready', payment: ready });
    await pending;
    expect(panel.location.assign).toHaveBeenCalledTimes(1);
  });

  it('does not navigate after an in-flight checkout panel is unmounted', async () => {
    let finish;
    const api = vi.fn().mockResolvedValueOnce({ checkout_availability: 'ready', payment: null }).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { panel, cleanup } = await loaded(api);
    const pending = panel.render().pay.onClick();
    cleanup();
    finish({ checkout_availability: 'ready', payment: ready });
    await pending;
    expect(panel.location.assign).not.toHaveBeenCalled();
  });

  it('allows status checks but disables starting in a closed room', async () => {
    const { panel } = await loaded(vi.fn().mockResolvedValue({ checkout_availability: 'ready', payment: ready }), { closed: true });
    expect(panel.render().pay.disabled).toBe(true);
    expect(panel.render().check.disabled).toBe(false);
  });
});


describe('React payment schema availability', () => {
  it.each([null, { ...ready, status: 'paid', redirect_url: null }])('keeps setup-required disabled while showing read-only payment status', async payment => {
    const api = vi.fn().mockResolvedValue({ checkout_availability: 'setup_required', payment });
    const { panel } = await loaded(api);
    expect(panel.render().pay.disabled).toBe(true);
    expect(panel.render().pay.children).toBe('Checkout unavailable');
    expect(panel.render().status).toContain('operator completes the payment safety upgrade');
    if (payment) expect(panel.render().status).toContain('Payment paid');
    await panel.render().pay.onClick();
    expect(api).toHaveBeenCalledTimes(1);
    await panel.render().check.onClick();
    expect(api).toHaveBeenCalledTimes(2);
    expect(panel.location.assign).not.toHaveBeenCalled();
  });
  it('blocks checkout after initial status failure, with no automatic retry', async () => {
    const api = vi.fn().mockRejectedValue(new Error('Payment status is temporarily unavailable'));
    const { panel } = await loaded(api);
    expect(panel.render().pay.disabled).toBe(true);
    expect(panel.render().status).not.toContain('upgrade');
    await panel.render().pay.onClick();
    expect(api).toHaveBeenCalledTimes(1);
    api.mockResolvedValue({ checkout_availability: 'ready', payment: null });
    await panel.render().check.onClick();
    expect(panel.render().pay.disabled).toBe(false);
  });
  it('revokes previously ready checkout after a status read failure', async () => {
    const api = vi.fn().mockResolvedValueOnce({ checkout_availability: 'ready', payment: ready }).mockRejectedValue(new Error('Read lost'));
    const { panel } = await loaded(api);
    expect(panel.render().pay.disabled).toBe(false);
    await panel.render().check.onClick();
    expect(panel.render().pay.disabled).toBe(true);
    await panel.render().pay.onClick();
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('does not assume a mixed-version response without readiness means checkout is safe', async () => {
    const { panel } = await loaded(vi.fn().mockResolvedValue({ payment: ready }));
    expect(panel.render().pay.disabled).toBe(true);
    expect(panel.render().status).not.toContain('upgrade');
  });
});


it('discards a late checkout response after the payment effect is replaced', async () => {
  let finish;
  const api = vi.fn().mockResolvedValueOnce({ checkout_availability: 'ready', payment: null })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ checkout_availability: 'ready', payment: null });
  const { panel, cleanup } = await loaded(api);
  const old = panel.render().pay.onClick();
  cleanup();
  panel.effects[0]();
  await flush();
  finish({ checkout_availability: 'ready', payment: ready });
  await old;
  expect(panel.location.assign).not.toHaveBeenCalled();
  expect(panel.render().status).toBe('No payment yet.');
});
