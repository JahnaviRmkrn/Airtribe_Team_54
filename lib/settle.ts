import { z } from 'zod';

// UPI settle-up helpers shared by the room API and its tests. Pure: no DB.

// NPCI handles are name@psp. Same pattern as the meetups.upi_vpa check.
export const VPA_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;
export const MIN_PAISE = 100;
export const MAX_PAISE = 10_000_000; // ₹1 lakh per person

export const settleBody = z.object({
  upi_vpa: z.string().trim().regex(VPA_RE, 'Enter a UPI ID like name@okhdfcbank'),
  upi_payee: z.string().trim().min(1).max(60),
  amount_paise: z.number().int().min(MIN_PAISE).max(MAX_PAISE),
});
export const settleConfirmBody = z.object({
  attendee_id: z.uuid(),
  confirmed: z.boolean(),
});

export type SettleConfig = { upi_vpa: string | null; upi_payee: string | null; settle_amount_paise: number | null };
export type SettlementRow = { attendee_id: string; status: 'claimed' | 'confirmed'; amount_paise: number };

// Even split of a total bill, rounded UP to the rupee so the organiser is never short.
export function splitPaise(totalPaise: number, people: number): number {
  if (!Number.isInteger(totalPaise) || totalPaise <= 0 || !Number.isInteger(people) || people <= 0) throw new RangeError('Invalid split');
  return Math.ceil(totalPaise / people / 100) * 100;
}

// upi://pay deep link (NPCI linking spec). Every value is percent-encoded; the
// note is trimmed because some UPI apps reject long notes.
export function upiUri(vpa: string, payee: string, amountPaise: number, note: string): string {
  if (!VPA_RE.test(vpa)) throw new Error('Invalid UPI ID');
  const q = new URLSearchParams({
    pa: vpa,
    pn: payee.slice(0, 60),
    am: (amountPaise / 100).toFixed(2),
    cu: 'INR',
    tn: note.replace(/[^\p{L}\p{N} .,'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 50) || 'muop meetup',
  });
  return 'upi://pay?' + q.toString().replace(/\+/g, '%20');
}

// What the room shows. Settle-up (payee name, UPI ID, amount, who has paid) goes
// only to joined guests and the organiser; anyone else holding the link gets null.
export function settleView(cfg: SettleConfig | null, rows: SettlementRow[], opts: { title: string; canSee: boolean }) {
  if (!opts.canSee || !cfg?.upi_vpa || !cfg.upi_payee || !cfg.settle_amount_paise) return null;
  const status: Record<string, SettlementRow['status']> = {};
  for (const r of rows) status[r.attendee_id] = r.status;
  return {
    amount_paise: cfg.settle_amount_paise,
    payee: cfg.upi_payee,
    upi_vpa: cfg.upi_vpa,
    upi_uri: upiUri(cfg.upi_vpa, cfg.upi_payee, cfg.settle_amount_paise, opts.title),
    status,
  };
}
