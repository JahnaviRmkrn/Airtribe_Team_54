'use client';
import { useEffect, useRef, useState } from 'react';

type Payment = { status: 'pending' | 'paid' | 'failed' | 'cancelled'; amount_paise: number; redirect_url: string | null; checkout_state?: 'ready' | 'creating' | 'reconciliation_required' };
export default function PaymentPanel({ callApi, closed, price }: {
  callApi: (method: string, suffix: string) => Promise<{ payment: Payment | null; checkout_availability?: string; message?: string }>;
  closed: boolean;
  price: number | null;
}) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [message, setMessage] = useState('Checking payment…');
  const [busy, setBusy] = useState(false);
  const [availability, setAvailability] = useState('unavailable');
  const [startUncertain, setStartUncertain] = useState(false);
  const checkoutBlocked = availability !== 'ready' || startUncertain || (!!payment && (payment.checkout_state === 'creating' || payment.checkout_state === 'reconciliation_required' || (payment.status === 'pending' && !payment.redirect_url)));
  const recoveryMessage = availability === 'setup_required'
    ? 'Checkout is unavailable until the operator completes the payment safety upgrade. You can still check an existing payment status.'
    : availability !== 'ready' ? 'Check payment status before paying. Checkout is unavailable until that check succeeds.'
    : payment?.checkout_state === 'creating'
    ? 'Payment is being created. Check payment status; do not start another checkout.'
    : checkoutBlocked ? 'Payment creation needs checking. Do not pay again. Check payment status or ask the organiser to reconcile it.' : '';
  const locked = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    generation.current++;
    let cancelled = false;
    locked.current = true; setBusy(true); setAvailability('unavailable');
    callApi('GET', '/pay').then(data => {
      if (!cancelled) { setPayment(data.payment); setAvailability(data.checkout_availability ?? 'unavailable'); setMessage(data.checkout_availability === 'ready' && !data.payment ? 'No payment yet.' : ''); }
    }).catch(e => { if (!cancelled) setMessage(e instanceof Error ? e.message : 'Could not check payment'); })
      .finally(() => { if (!cancelled) { locked.current = false; setBusy(false); } });
    return () => { cancelled = true; alive.current = false; };
  }, [callApi]);
  async function update(start: boolean) {
    if (locked.current || (start && checkoutBlocked)) return;
    const currentGeneration = generation.current;
    locked.current = true; setBusy(true);
    try {
      const data = await callApi(start ? 'POST' : 'GET', '/pay');
      if (!alive.current || currentGeneration !== generation.current) return;
      setPayment(data.payment); setAvailability(data.checkout_availability ?? 'unavailable'); setStartUncertain(false); setMessage(data.checkout_availability === 'ready' && !data.payment ? 'No payment yet.' : '');
      if (start && data.checkout_availability === 'ready' && data.payment?.status === 'pending' && data.payment.redirect_url) {
        const url = new URL(data.payment.redirect_url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid checkout link');
        location.assign(url.href);
      }
    } catch (e) {
      if (alive.current && currentGeneration === generation.current) {
        setAvailability('unavailable');
        if (start) setStartUncertain(true);
        setMessage(e instanceof Error ? e.message : 'Could not check payment');
      }
    } finally { if (currentGeneration === generation.current) { locked.current = false; if (alive.current) setBusy(false); } }
  }
  return <section className="room-card" aria-label="Your payment">
    <h2>Your payment</h2>
    <p role="status" aria-live="polite">{[payment && `Payment ${payment.status} · ₹${payment.amount_paise / 100}`, message || recoveryMessage].filter(Boolean).join('. ')}</p>
    <p>Checkout opens on Pine Labs. Returning here does not confirm payment; check status after checkout.</p>
    <button type="button" className="room-primary" disabled={busy || checkoutBlocked || closed || !(price && price > 0) || payment?.status === 'paid'} onClick={() => update(true)}>
      {availability === 'setup_required' ? 'Checkout unavailable' : checkoutBlocked ? 'Check status before paying' : payment?.status === 'pending' ? 'Continue checkout' : `Pay ₹${price ?? 0} with Pine Labs`}
    </button>{' '}
    <button type="button" disabled={busy} onClick={() => update(false)}>Check payment status</button>
  </section>;
}
