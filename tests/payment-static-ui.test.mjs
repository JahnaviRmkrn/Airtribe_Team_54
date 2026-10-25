import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/room/room.js', import.meta.url), 'utf8').replace(/\nif \(!TOKEN\) \{[\s\S]*$/, '');
const ready = { checkout_availability: 'ready', payment: { status: 'pending', amount_paise: 50000, redirect_url: 'https://pay.example/A', checkout_state: 'ready' } };
function room(api) {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle() {} }, textContent: '' });
    return nodes.get(id);
  } };
  const location = { pathname: '/m/synthetic-room-token-123', assign: vi.fn() };
  const context = vm.createContext({ document, location, window: {}, URL, fakeApi: api });
  vm.runInContext(source, context);
  vm.runInContext("api = fakeApi; view = { me: { attendee_id: 'guest' }, meetup: { status: 'open', final_venue: { price_per_person: 500 } } }; paymentLoadedFor = 'guest'", context);
  return { location, nodes, run: script => vm.runInContext(script, context) };
}
describe('static room checkout availability', () => {
  it('disables setup-required checkout, displays paid status and allows only manual checks', async () => {
    const api = vi.fn().mockResolvedValue({ checkout_availability: 'setup_required', payment: { ...ready.payment, status: 'paid', redirect_url: null } });
    const ui = room(api);
    await ui.run('updatePayment(false)');
    expect(ui.nodes.get('pay-btn').disabled).toBe(true);
    expect(ui.nodes.get('pay-btn').textContent).toBe('Checkout unavailable');
    expect(ui.nodes.get('payment-status').textContent).toContain('Payment paid');
    expect(ui.nodes.get('payment-status').textContent).toContain('operator completes');
    await ui.run('updatePayment(true)');
    expect(api).toHaveBeenCalledTimes(1);
    expect(ui.nodes.get('payment-check').disabled).toBe(false);
    await ui.run('updatePayment(false)');
    expect(api).toHaveBeenCalledTimes(2);
    expect(ui.location.assign).not.toHaveBeenCalled();
  });
  it('keeps failed and unverified status reads disabled without an automatic retry', async () => {
    const api = vi.fn().mockRejectedValue(new Error('Payment status is temporarily unavailable'));
    const ui = room(api);
    await ui.run('updatePayment(false)');
    expect(ui.nodes.get('pay-btn').disabled).toBe(true);
    expect(ui.nodes.get('payment-status').textContent).not.toContain('upgrade');
    await ui.run('updatePayment(true)');
    expect(api).toHaveBeenCalledTimes(1);
    api.mockResolvedValue({ payment: ready.payment });
    await ui.run('updatePayment(false)');
    expect(ui.nodes.get('pay-btn').disabled).toBe(true);
    api.mockResolvedValue(ready);
    await ui.run('updatePayment(false)');
    expect(ui.nodes.get('pay-btn').disabled).toBe(false);
    expect(ui.location.assign).not.toHaveBeenCalled();
    await ui.run('updatePayment(true)');
    expect(ui.location.assign).toHaveBeenCalledTimes(1);
  });
  it('revokes previously ready checkout after any failed status check', async () => {
    const api = vi.fn().mockResolvedValueOnce(ready).mockRejectedValue(new Error('Read response lost'));
    const ui = room(api);
    await ui.run('updatePayment(false)');
    expect(ui.nodes.get('pay-btn').disabled).toBe(false);
    await ui.run('updatePayment(false)');
    expect(ui.nodes.get('pay-btn').disabled).toBe(true);
    await ui.run('updatePayment(true)');
    expect(api).toHaveBeenCalledTimes(2);
  });
});


describe('static payment response identity fencing', () => {
  it.each([true, false])('discards a late %s request after the guest changes', async start => {
    let finish;
    const api = vi.fn().mockResolvedValueOnce(ready)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ checkout_availability: 'ready', payment: null });
    const ui = room(api);
    await ui.run('updatePayment(false)');
    const previous = ui.run(`updatePayment(${start})`);
    ui.run("view.me.attendee_id = 'new-guest'; renderPayment()");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    finish(ready);
    await previous;
    expect(ui.run('payment')).toBeNull();
    expect(ui.run('paymentAvailability')).toBe('ready');
    expect(ui.location.assign).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('does not navigate a late checkout response after the room path changes', async () => {
    let finish;
    const api = vi.fn().mockResolvedValueOnce(ready).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ui = room(api);
    await ui.run('updatePayment(false)');
    const previous = ui.run('updatePayment(true)');
    ui.location.pathname = '/m/different-synthetic-room';
    finish(ready);
    await previous;
    expect(ui.location.assign).not.toHaveBeenCalled();
  });
});
