import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// Runs the real room script (minus boot) against a minimal DOM stub.
const source = readFileSync(new URL('../public/room/room.js', import.meta.url), 'utf8').replace(/\n\$\('settle-qr-btn'\)\.onclick[\s\S]*$/, '');
function room(view) {
  const nodes = new Map();
  const node = () => {
    const hidden = new Set();
    return {
      textContent: '', innerHTML: '', attrs: {}, hidden,
      classList: {
        toggle(c, on) { if (c !== 'hidden') return; if (on) hidden.add('h'); else hidden.delete('h'); },
        add() { hidden.add('h'); }, remove() { hidden.delete('h'); },
      },
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      querySelectorAll: () => [],
      get isHidden() { return hidden.size > 0; },
    };
  };
  // Summary mode renders no form, as in the real page.
  const document = { getElementById(id) { if (id === 'settle-form' || id === 'settle-cancel') return null; if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } };
  const context = vm.createContext({ document, location: { pathname: '/m/synthetic-room-token-123', assign: vi.fn() }, window: {}, URL, sessionStorage: { getItem: () => null, setItem() {} }, fakeView: view });
  vm.runInContext(source, context);
  vm.runInContext('view = fakeView; paymentLoadedFor = fakeView.me && fakeView.me.attendee_id; updatePayment = () => {}', context);
  return { nodes, run: (code) => vm.runInContext(code, context) };
}
const settle = { amount_paise: 75000, payee: 'Alice', upi_vpa: 'alice.k@okhdfcbank', upi_uri: 'upi://pay?pa=alice.k%40okhdfcbank&am=750.00', status: {} };
const base = (over = {}) => ({
  me: { attendee_id: 'g1' }, is_organizer: false, attendees: [{ id: 'g1', guest_name: 'Guest' }],
  meetup: { status: 'closed', final_venue: { price_per_person: 750 } },
  checkout_configured: true, payments: {}, settle_up: settle, ...over,
});

describe('static room: UPI settle-up never invites a second payment', () => {
  it('offers UPI pay link, QR and "I\'ve paid" when there is no card payment, and hides the Pine Labs card', () => {
    const ui = room(base());
    ui.run('renderPayment(); renderSettle()');
    expect(ui.nodes.get('payment-card').isHidden).toBe(true);
    expect(ui.nodes.get('settle-card').isHidden).toBe(false);
    expect(ui.nodes.get('settle-pay').attrs.href).toBe(settle.upi_uri);
    expect(ui.nodes.get('settle-pay').isHidden).toBe(false);
    expect(ui.nodes.get('settle-claim').isHidden).toBe(false);
  });

  it.each(['paid', 'pending', 'failed', 'cancelled'])('keeps the card payment panel and blocks UPI payment when a card payment is %s', (status) => {
    const ui = room(base({ payments: { g1: status } }));
    ui.run('renderPayment(); renderSettle()');
    expect(ui.nodes.get('payment-card').isHidden).toBe(false);
    for (const id of ['settle-pay', 'settle-qr-btn', 'settle-copy', 'settle-claim', 'settle-undo']) expect(ui.nodes.get(id).isHidden).toBe(true);
    expect(ui.nodes.get('settle-status').textContent).toMatch(status === 'paid' ? /already paid by card/ : /do not pay again/);
  });

  it('hides a dead-end card when checkout has no credentials and no card payment exists', () => {
    const ui = room(base({ settle_up: null, checkout_configured: false }));
    ui.run('renderPayment(); renderSettle()');
    expect(ui.nodes.get('payment-card').isHidden).toBe(true);
    expect(ui.nodes.get('settle-card').isHidden).toBe(true);
  });

  it('never uses a non-UPI link as the pay href', () => {
    const ui = room(base({ settle_up: { ...settle, upi_uri: 'javascript:alert(1)' } }));
    ui.run('renderSettle()');
    expect(ui.nodes.get('settle-pay').attrs.href).toBeUndefined();
  });

  it('shows the organiser who paid by card instead of a collect button', () => {
    const ui = room(base({ is_organizer: true, payments: { g1: 'paid' } }));
    ui.run('renderOrgSettle()');
    expect(ui.nodes.get('org-settle-list').innerHTML).toContain('Paid by card');
    expect(ui.nodes.get('org-settle-list').innerHTML).not.toContain('data-settle');
  });
});
