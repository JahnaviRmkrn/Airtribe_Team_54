-- UPI settle-up: the organiser collects each guest's share straight to their
-- own UPI ID. No payment gateway, no merchant KYC: guests pay in their UPI app,
-- tap "I've paid", and the organiser ticks off what reached their account.
-- muop never moves money, so "claimed" is the guest's word, "confirmed" the organiser's.

alter table public.meetups
  add column upi_vpa text check (upi_vpa ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  add column upi_payee text check (length(trim(upi_payee)) between 1 and 60),
  add column settle_amount_paise int check (settle_amount_paise between 100 and 10000000),
  -- All three or none: a half-configured settle-up never reaches guests.
  add constraint meetups_settle_complete check (
    (upi_vpa is null and upi_payee is null and settle_amount_paise is null)
    or (upi_vpa is not null and upi_payee is not null and settle_amount_paise is not null));

create table public.meetup_settlements (
  id uuid primary key default gen_random_uuid(),
  meetup_id uuid not null references public.meetups (id) on delete cascade,
  attendee_id uuid not null references public.meetup_attendees (id) on delete cascade,
  amount_paise int not null check (amount_paise > 0),
  status text not null default 'claimed' check (status in ('claimed', 'confirmed')),
  claimed_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (meetup_id, attendee_id),
  check ((status = 'confirmed') = (confirmed_at is not null))
);

create trigger settlements_touch before update on public.meetup_settlements
  for each row execute function public.touch_updated_at();

-- Same rule as payments: the attendee must belong to the meetup.
create trigger settlements_attendee before insert or update on public.meetup_settlements
  for each row execute function public.check_payment_attendee();

-- No anon or guest policies: the room API writes with the service role after
-- checking the guest cookie or the organiser session.
alter table public.meetup_settlements enable row level security;

create policy organizer_reads_settlements on public.meetup_settlements for select to authenticated
  using (exists (select 1 from public.meetups m where m.id = meetup_id and m.organizer_id = auth.uid()));
