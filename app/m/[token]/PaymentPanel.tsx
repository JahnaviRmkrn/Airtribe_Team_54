'use client';
import { useEffect, useRef, useState } from 'react';

type Payment = { status: 'pending' | 'paid' | 'failed' | 'cancelled'; amount_paise: number; redirect_url: string | null };
export default function PaymentPanel({ callApi, closed, price }: {
  callApi: (method: string, suffix: string) => Promise<{ payment: Payment | null }>;
  closed: boolean;
  price: number | null;
}) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [message, setMessage] = useState('Checking payment…');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    locked.current = true; setBusy(true);
    callApi('GET', '/pay').then(data => {
      if (!cancelled) { setPayment(data.payment); setMessage(data.payment ? '' : 'No payment yet.'); }
    }).catch(e => { if (!cancelled) setMessage(e instanceof Error ? e.message : 'Could not check payment'); })
      .finally(() => { if (!cancelled) { locked.current = false; setBusy(false); } });
    return () => { cancelled = true; alive.current = false; };
  }, [callApi]);
  async function update(start: boolean) {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      const data = await callApi(start ? 'POST' : 'GET', '/pay');
      if (!alive.current) return;
      setPayment(data.payment); setMessage(data.payment ? '' : 'No payment yet.');
      if (start && data.payment?.status === 'pending' && data.payment.redirect_url) {
        const url = new URL(data.payment.redirect_url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid checkout link');
        location.assign(url.href);
      }
    } catch (e) {
      if (alive.current) setMessage(e instanceof Error ? e.message : 'Could not check payment');
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="room-card" aria-label="Your payment">
    <h2>Your payment</h2>
    <p role="status" aria-live="polite">{message || (payment && `Payment ${payment.status} · ₹${payment.amount_paise / 100}`)}</p>
    <p>Checkout opens on Pine Labs. Returning here does not confirm payment; check status after checkout.</p>
    <button type="button" className="room-primary" disabled={busy || closed || !(price && price > 0) || payment?.status === 'paid'} onClick={() => update(true)}>
      {payment?.status === 'pending' ? 'Continue checkout' : `Pay ₹${price ?? 0} with Pine Labs`}
    </button>{' '}
    <button type="button" disabled={busy} onClick={() => update(false)}>Check payment status</button>
  </section>;
}
