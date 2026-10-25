-- RLS / grant regression checks. Run against a THROWAWAY Postgres that has the
-- Supabase roles and auth schema (e.g. the public.ecr.aws/supabase/postgres
-- image) after applying supabase/migrations/*.sql and seed.sql:
--
--   psql -U postgres -v ON_ERROR_STOP=1 -q -f supabase/tests/rls.sql
--
-- Never run it against a database with real data: it inserts and deletes test
-- users. Raises an exception (non-zero exit) on the first failed check.

-- 1. Structure ---------------------------------------------------------------
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    raise exception 'RLS is not enabled on public.%', t;
  end loop;

  for t in select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') loop
    raise exception 'SECURITY DEFINER function public.% has no fixed search_path', t;
  end loop;

  if exists (select 1 from information_schema.role_table_grants
             where grantee = 'anon' and table_schema = 'public') then
    raise exception 'anon still holds table privileges in public';
  end if;
  if exists (select 1 from information_schema.role_table_grants
             where grantee = 'authenticated' and table_schema = 'public' and table_name = 'rate_limits') then
    raise exception 'authenticated can touch rate_limits';
  end if;
  if exists (select 1 from information_schema.role_table_grants
             where grantee = 'authenticated' and table_schema = 'public'
               and table_name in ('meetup_attendees', 'venue_votes', 'meetup_payments', 'venues')
               and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) then
    raise exception 'authenticated can write service-only tables';
  end if;
end $$;

-- 2. Fixtures (as superuser) -----------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@example.com'),
       ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@example.com')
on conflict do nothing;

insert into public.contacts (id, user_id, name, category)
values ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A contact', 'personal'),
       ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B contact', 'personal')
on conflict do nothing;

insert into public.meetups (id, organizer_id, title)
values ('20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A meetup'),
       ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B meetup')
on conflict do nothing;

insert into public.meetup_attendees (id, meetup_id, guest_name, secret_hash)
values ('30000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a1', 'Guest of A', 'hash-a'),
       ('30000000-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000b2', 'Guest of B', 'hash-b')
on conflict do nothing;

insert into public.meetup_payments (meetup_id, attendee_id, amount_paise)
values ('20000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 10000)
on conflict do nothing;

-- 3. anon sees and does nothing ---------------------------------------------------
set role anon;
do $$
declare t text;
begin
  foreach t in array array['contacts', 'interactions', 'balance_goals', 'venues', 'meetups', 'meetup_attendees',
                           'venue_votes', 'saved_discoveries', 'meetup_payments', 'rate_limits'] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'anon could SELECT public.%', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.hit_rate_limit('k', 60, 5);
    raise exception 'anon could call hit_rate_limit';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_interaction('10000000-0000-0000-0000-0000000000a1', now(), 'call', null, null, false);
    raise exception 'anon could call record_interaction';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 4. authenticated user A: own rows only; no service-only access ------------------
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
do $$
declare n int;
begin
  select count(*) into n from public.contacts;
  if n <> 1 then raise exception 'A sees % contacts, expected 1', n; end if;
  select count(*) into n from public.contacts where user_id <> auth.uid();
  if n <> 0 then raise exception 'A can read another user''s contacts'; end if;
  select count(*) into n from public.meetups;
  if n <> 1 then raise exception 'A sees % meetups, expected 1', n; end if;
  select count(*) into n from public.meetup_attendees;
  if n <> 1 then raise exception 'A sees % attendees, expected only their own meetup''s', n; end if;
  select count(*) into n from public.meetup_payments;
  if n <> 0 then raise exception 'A can read payments of someone else''s meetup'; end if;

  -- cannot act as another user
  begin
    insert into public.contacts (user_id, name, category) values ('00000000-0000-0000-0000-0000000000b2', 'x', 'personal');
    raise exception 'A inserted a contact for B';
  exception when insufficient_privilege or check_violation then null;
  end;
  update public.contacts set name = 'hijack' where id = '10000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'A updated B''s contact'; end if;
  begin
    perform public.record_interaction('10000000-0000-0000-0000-0000000000b2', now(), 'call', null, null, false);
    raise exception 'A recorded an interaction on B''s contact';
  exception when sqlstate 'P0002' then null;
  end;

  -- service-only tables
  begin
    insert into public.meetup_attendees (meetup_id, guest_name, secret_hash)
    values ('20000000-0000-0000-0000-0000000000a1', 'forged', 'x');
    raise exception 'authenticated inserted an attendee';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.meetup_payments (meetup_id, attendee_id, amount_paise, status)
    values ('20000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', 1, 'paid');
    raise exception 'authenticated inserted a payment';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.meetup_payments set status = 'paid';
    raise exception 'authenticated updated payments';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.venues (name, area) values ('fake', 'fake');
    raise exception 'authenticated inserted a venue';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.rate_limits limit 1;
    raise exception 'authenticated read rate_limits';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.hit_rate_limit('k', 60, 5);
    raise exception 'authenticated called hit_rate_limit';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 5. service_role: the limiter works and refuses abusive keys ----------------------
set role service_role;
do $$
begin
  if not public.hit_rate_limit('rls-test', 60, 1) then raise exception 'first hit denied'; end if;
  if public.hit_rate_limit('rls-test', 60, 1) then raise exception 'second hit allowed over max 1'; end if;
  begin
    perform public.hit_rate_limit(repeat('x', 301), 60, 1);
    raise exception 'oversized key accepted';
  exception when raise_exception then
    if sqlerrm like 'oversized%' then raise; end if;
  end;
end $$;
reset role;

-- 6. Cleanup ------------------------------------------------------------------------
delete from public.rate_limits where key = 'rls-test';
delete from public.meetups where id in ('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b2');
delete from public.contacts where id in ('10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000b2');
delete from auth.users where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2');
select 'rls checks passed' as result;
