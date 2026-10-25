-- A provider timeout is not proof that an order was not created. Persist the
-- merchant reference before calling the provider and never expire that claim.
-- This is a local attempt ledger, NOT a provider idempotency-key guarantee.
alter table public.meetup_payments add column merchant_order_reference text unique;

create table public.meetup_payment_attempts (
  merchant_order_reference text primary key,
  payment_id uuid not null references public.meetup_payments (id) on delete cascade,
  amount_paise int not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  state text not null default 'creating' check (state in ('creating', 'uncertain', 'received')),
  pine_order_id text unique,
  redirect_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'received') = (pine_order_id is not null and redirect_url is not null)),
  check ((pine_order_id is null) = (redirect_url is null))
);

create trigger payment_attempts_touch before update on public.meetup_payment_attempts
  for each row execute function public.touch_updated_at();

-- A known receipt must never silently turn into a different provider order.
create function public.check_payment_attempt_receipt() returns trigger language plpgsql as $$
begin
  if new.merchant_order_reference is distinct from old.merchant_order_reference
     or new.payment_id is distinct from old.payment_id
     or new.amount_paise is distinct from old.amount_paise
     or new.currency is distinct from old.currency then
    raise exception 'payment_attempt_identity_immutable';
  end if;
  if old.state = 'received' and (
    new.state <> 'received'
    or new.pine_order_id is distinct from old.pine_order_id
    or new.redirect_url is distinct from old.redirect_url
  ) then
    raise exception 'payment_attempt_receipt_immutable';
  end if;
  return new;
end $$;
create trigger payment_attempts_receipt before update on public.meetup_payment_attempts
  for each row execute function public.check_payment_attempt_receipt();

alter table public.meetup_payment_attempts enable row level security;
-- Owners can inspect references for manual reconciliation, but neither guests
-- nor authenticated organizers may forge or edit provider receipts.
create policy organizer_reads_payment_attempts on public.meetup_payment_attempts
  for select to authenticated using (exists (
    select 1 from public.meetup_payments p join public.meetups m on m.id = p.meetup_id
    where p.id = payment_id and m.organizer_id = auth.uid()
  ));

-- Old code labelled any create exception failed, even when the provider might
-- have committed. Unknown legacy failures must not authorize another order.
update public.meetup_payments set status = 'pending'
  where status in ('failed', 'cancelled') and pine_order_id is null;

-- Fence old application instances too: the previous implementation re-claimed
-- pending/no-ID rows after two minutes and marked unknown outcomes failed.
-- Only attaching the SAME attempt's known provider order can advance the row.
create function public.guard_unknown_payment_attempt() returns trigger language plpgsql as $$
begin
  if old.status = 'pending' and old.pine_order_id is null and (
    new.pine_order_id is null
    or new.merchant_order_reference is distinct from old.merchant_order_reference
    or new.amount_paise is distinct from old.amount_paise
  ) then
    raise exception 'payment_attempt_requires_reconciliation';
  end if;
  return new;
end $$;
create trigger payments_unknown_attempt before update on public.meetup_payments
  for each row execute function public.guard_unknown_payment_attempt();
