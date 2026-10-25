import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

function boot(api = vi.fn()) {
  const nodes = new Map<string, { textContent: string; disabled: boolean; classList: { toggle: ReturnType<typeof vi.fn> } }>();
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false, classList: { toggle: vi.fn() } });
    return nodes.get(id)!;
  };
  const source = readFileSync('public/room/room.js', 'utf8');
  const location = { assign: vi.fn(), search: '?payment=done&status=paid' };
  const context = vm.createContext({ $, api, location, URL, rupees: (n: number) => `₹${n}` });
  vm.runInContext(source.slice(source.indexOf('let paymentBusy'), source.indexOf('const $ =')), context);
  // These flow tests begin after a successful initial readiness check.
  vm.runInContext("var view = {me:{attendee_id:'guest'},meetup:{status:'open',final_venue:{price_per_person:450}}}; paymentLoadedFor='guest'; paymentAvailability='ready';", context);
  return { nodes, $, api, location, run: (s: string) => vm.runInContext(s, context) };
}

describe('guest checkout controls', () => {
  it('does not infer payment success or navigate on callback/status lookup', async () => {
    const b = boot(vi.fn().mockResolvedValue({ checkout_availability: 'ready', payment: {status:'pending',amount_paise:45000,redirect_url:'https://api.pluralonline.com/checkout'} }));
    await b.run('updatePayment(false)');
    expect(b.api).toHaveBeenCalledWith('/pay', {method:'GET'});
    expect(b.location.assign).not.toHaveBeenCalled();
    expect(b.$('payment-status').textContent).toContain('pending');
  });
  it('navigates only after an explicit checkout request', async () => {
    const b = boot(vi.fn().mockResolvedValue({ checkout_availability: 'ready', payment: {status:'pending',amount_paise:45000,redirect_url:'https://api.pluralonline.com/checkout'} }));
    await b.run('updatePayment(true)');
    expect(b.api).toHaveBeenCalledWith('/pay', {method:'POST'});
    expect(b.location.assign).toHaveBeenCalledWith('https://api.pluralonline.com/checkout');
  });
  it('blocks duplicate starts while a request is pending', async () => {
    let resolve!: (v: unknown) => void;
    const b = boot(vi.fn().mockReturnValue(new Promise(r => { resolve = r; })));
    const first = b.run('updatePayment(true)');
    await b.run('updatePayment(true)');
    expect(b.api).toHaveBeenCalledTimes(1);
    resolve({checkout_availability:'ready',payment:null}); await first;
  });
  it.each(['paid','failed','cancelled'])('shows provider %s without navigating', async status => {
    const b = boot(vi.fn().mockResolvedValue({checkout_availability:'ready',payment:{status,amount_paise:45000,redirect_url:null}}));
    await b.run('updatePayment(false)');
    expect(b.$('payment-status').textContent).toContain(status);
    expect(b.location.assign).not.toHaveBeenCalled();
    expect(b.$('pay-btn').disabled).toBe(status === 'paid');
  });
  it('disables new checkout for a closed room', () => {
    const b = boot(); b.run("view.meetup.status='closed'; renderPayment()");
    expect(b.$('pay-btn').disabled).toBe(true);
    expect(b.$('payment-check').disabled).toBe(false);
  });
  it('surfaces unavailable payments and rejects unsafe redirects', async () => {
    const b = boot(vi.fn().mockRejectedValue(new Error('Payments are not configured')));
    await b.run('updatePayment(true)');
    expect(b.$('payment-status').textContent).toContain('not configured');
    b.api.mockResolvedValueOnce({checkout_availability:'ready',payment:null});
    await b.run('updatePayment(false)');
    b.api.mockResolvedValue({checkout_availability:'ready',payment:{status:'pending',amount_paise:45000,redirect_url:'javascript:alert(1)'}});
    await b.run('updatePayment(true)');
    expect(b.location.assign).not.toHaveBeenCalled();
    expect(b.$('payment-status').textContent).toContain('Invalid checkout link');
  });
  it.each(['creating', 'reconciliation_required'])('blocks automatic retry and explains %s', async checkout_state => {
    const b = boot(vi.fn().mockResolvedValue({checkout_availability:'ready',payment:{status:'pending',amount_paise:45000,redirect_url:null,checkout_state}}));
    await b.run('updatePayment(false)');
    expect(b.$('pay-btn').disabled).toBe(true);
    expect(b.$('payment-check').disabled).toBe(false);
    expect(b.$('payment-status').textContent).toMatch(/do not start|Do not pay again/);
    await b.run('updatePayment(true)');
    expect(b.api).toHaveBeenCalledTimes(1);
    expect(b.location.assign).not.toHaveBeenCalled();
  });
  it('requires a status check after an uncertain POST, and recovers only the same checkout', async () => {
    const b = boot(vi.fn().mockRejectedValueOnce(new Error('Synthetic response loss')));
    await b.run('updatePayment(true)');
    expect(b.$('pay-btn').disabled).toBe(true);
    await b.run('updatePayment(true)');
    expect(b.api).toHaveBeenCalledTimes(1);
    b.api.mockResolvedValue({checkout_availability:'ready',payment:{status:'pending',amount_paise:45000,redirect_url:'https://pay.example/A',checkout_state:'ready'}});
    await b.run('updatePayment(false)');
    expect(b.$('pay-btn').disabled).toBe(false);
    expect(b.location.assign).not.toHaveBeenCalled();
    await b.run('updatePayment(true)');
    expect(b.location.assign).toHaveBeenCalledWith('https://pay.example/A');
  });

});
