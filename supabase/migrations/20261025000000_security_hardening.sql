-- Security hardening (defence in depth). Idempotent: safe to re-run.
--
-- The app never uses the anon role against tables (guests go through the
-- server-side room API with the service role; organisers use the
-- authenticated role), and RLS already denies anon everywhere. These grants
-- make that explicit so a future table, or a policy added with `to public`,
-- cannot expose data to anyone without a session.

-- 1. anon: no table, sequence or routine access in public ---------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- 2. authenticated: read-only where the API writes with the service role ------
-- Organisers may read attendees/votes/payments of their own meetups (RLS), and
-- the venue catalogue. Every write to these goes through the room API.
revoke insert, update, delete, truncate, references, trigger
  on public.meetup_attendees, public.venue_votes, public.meetup_payments, public.venues
  from authenticated;

-- 3. record_interaction: signed-in users only (functions default to PUBLIC) ----
revoke execute on function public.record_interaction(uuid, timestamptz, text, text, timestamptz, boolean)
  from public, anon;
grant execute on function public.record_interaction(uuid, timestamptz, text, text, timestamptz, boolean)
  to authenticated;

-- 4. hit_rate_limit: SECURITY DEFINER with an empty search_path ---------------
-- Everything is schema-qualified, so no object in a writable schema can shadow
-- one the function uses. Keys are length-capped so a caller cannot bloat the
-- table with huge keys. Still executable by service_role only.
create or replace function public.hit_rate_limit(p_key text, p_window_seconds int, p_max int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  w timestamptz;
  n int;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be > 0';
  end if;
  if p_key is null or length(p_key) not between 1 and 300 then
    raise exception 'p_key must be 1-300 characters';
  end if;
  w := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits as r (key, window_start, count) values (p_key, w, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into n;

  -- Opportunistic cleanup: ~1 in 100 calls drops windows older than a day.
  if pg_catalog.random() < 0.01 then
    delete from public.rate_limits where window_start < pg_catalog.now() - interval '1 day';
  end if;

  return n <= p_max;
end $$;

revoke execute on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;

-- 5. Bound guest-supplied JSON (the API validates too; this is the backstop) --
-- NOT VALID: applies to new and updated rows without scanning old ones.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attendees_preferences_size') then
    alter table public.meetup_attendees
      add constraint attendees_preferences_size check (pg_column_size(preferences) <= 8192) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attendees_availability_size') then
    alter table public.meetup_attendees
      add constraint attendees_availability_size check (pg_column_size(availability) <= 4096) not valid;
  end if;
end $$;
