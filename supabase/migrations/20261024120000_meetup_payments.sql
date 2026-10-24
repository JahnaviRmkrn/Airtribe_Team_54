-- Guest payments (Pine Labs Online) for a meetup's confirmed venue.
-- One row per guest per meetup; a failed/cancelled row is reused for a retry.
-- No anon policies: the room API reads and writes it with the service role.

create table public.meetup_payments (
  id uuid primary key default gen_random_uuid(),
  meetup_id uuid not null references public.meetups (id) on delete cascade,
  attendee_id uuid not null references public.meetup_attendees (id) on delete cascade,
  amount_paise int not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  pine_order_id text unique,  -- null only while the order is being created
  redirect_url text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meetup_id, attendee_id)
);

create trigger payments_touch before update on public.meetup_payments
  for each row execute function public.touch_updated_at();

-- Payment must reference an attendee of the same meetup.
create function public.check_payment_attendee() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.meetup_attendees a where a.id = new.attendee_id and a.meetup_id = new.meetup_id) then
    raise exception 'attendee not in meetup';
  end if;
  return new;
end $$;
create trigger payments_attendee before insert or update on public.meetup_payments
  for each row execute function public.check_payment_attendee();

alter table public.meetup_payments enable row level security;

create policy organizer_reads_payments on public.meetup_payments for select to authenticated
  using (exists (select 1 from public.meetups m where m.id = meetup_id and m.organizer_id = auth.uid()));
