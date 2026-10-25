-- Optional Google connector infrastructure. Authoring this migration does not
-- enable a provider, create a grant, or connect a Google account.
-- Only application servers may see encrypted transient payloads. The user's
-- normal Supabase session cannot read or write this table, even for its owner.
create table public.google_connector_sessions (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar')),
  encrypted_payload text not null,
  expires_at timestamptz not null,
  lease uuid,
  locked_until timestamptz,
  unique (user_id, purpose)
);
create index google_connector_expiry_idx on public.google_connector_sessions(expires_at);
alter table public.google_connector_sessions enable row level security;
revoke all on public.google_connector_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.google_connector_sessions to service_role;

create function public.claim_google_connector_session(p_id text, p_owner uuid, p_purpose text, p_lease uuid)
returns table(encrypted_payload text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.google_connector_sessions%rowtype;
begin
  select * into s from public.google_connector_sessions
    where id = p_id and user_id = p_owner and purpose = p_purpose for update;
  if not found then return; end if;
  if s.expires_at <= now() then
    delete from public.google_connector_sessions where id = p_id;
    return;
  end if;
  if s.locked_until > now() then raise exception 'connector_busy'; end if;
  update public.google_connector_sessions set lease = p_lease, locked_until = now() + interval '30 seconds' where id = p_id;
  return query select s.encrypted_payload, s.expires_at;
end;
$$;
revoke all on function public.claim_google_connector_session(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_google_connector_session(text, uuid, text, uuid) to service_role;

-- Treat email case-insensitively. A name-only contact also matches an existing
-- name, but two people with different nonempty emails are not conflated.
create function public.google_contact_matches(existing_name text, existing_email text, candidate_name text, candidate_email text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select case when nullif(btrim(existing_email), '') is not null and nullif(btrim(candidate_email), '') is not null
    then lower(btrim(existing_email)) = lower(btrim(candidate_email))
    else lower(btrim(existing_name)) = lower(btrim(candidate_name)) end;
$$;
revoke all on function public.google_contact_matches(text, text, text, text) from public, anon, authenticated;
grant execute on function public.google_contact_matches(text, text, text, text) to service_role;

create function public.preview_google_contact_duplicates(p_owner uuid, p_contacts jsonb)
returns table(id text) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(p_contacts) <> 'array' or jsonb_array_length(p_contacts) > 1000 then raise exception 'invalid_preview'; end if;
  return query select candidate->>'id' from jsonb_array_elements(p_contacts) candidate
    where exists (select 1 from public.contacts c where c.user_id = p_owner
      and public.google_contact_matches(c.name, c.email, candidate->>'name', candidate->>'email'));
end;
$$;
revoke all on function public.preview_google_contact_duplicates(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.preview_google_contact_duplicates(uuid, jsonb) to service_role;

-- Only the server can call this, after resolving selected IDs against its
-- encrypted owner-bound preview. Do not expose a service-role key to a client.
-- An owner-level lock serializes imports across sessions/purposes. All checks
-- and inserts are atomic; a lost HTTP response can be retried without duplicates.
create function public.import_google_contacts(p_session text, p_owner uuid, p_purpose text, p_lease uuid, p_contacts jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c jsonb; n text; e text; cat public.life_category; tags text[]; note text; added integer := 0; skipped integer := 0;
begin
  if p_purpose not in ('contacts', 'sheets-import') then raise exception 'invalid_import_purpose'; end if;
  perform 1 from public.google_connector_sessions where id = p_session and user_id = p_owner and purpose = p_purpose
    and lease = p_lease and locked_until > now() and expires_at > now() for update;
  if not found then raise exception 'connector_expired'; end if;
  if jsonb_typeof(p_contacts) <> 'array' or jsonb_array_length(p_contacts) not between 1 and 5 then raise exception 'invalid_import_batch'; end if;
  perform pg_advisory_xact_lock(hashtextextended('google-contact-import:' || p_owner::text, 0));
  for c in select value from jsonb_array_elements(p_contacts) loop
    n := btrim(c->>'name'); e := nullif(btrim(c->>'email'), ''); cat := (c->>'category')::public.life_category;
    if n is null or length(n) not between 1 and 120 or cat is null or length(e) > 254 then raise exception 'invalid_import_contact'; end if;
    tags := '{}'; note := null;
    -- Sheets may explicitly map these fields. Contacts never supplies them.
    if c ? 'interests' then
      if jsonb_typeof(c->'interests') <> 'array' or jsonb_array_length(c->'interests') > 20 then raise exception 'invalid_import_interests'; end if;
      if exists(select 1 from jsonb_array_elements(c->'interests') value where jsonb_typeof(value) <> 'string' or length(btrim(value #>> '{}')) not between 1 and 40) then raise exception 'invalid_import_interests'; end if;
      select coalesce(array_agg(btrim(value)), '{}') into tags from jsonb_array_elements_text(c->'interests');
    end if;
    if c ? 'notes' and c->'notes' <> 'null'::jsonb then
      if jsonb_typeof(c->'notes') <> 'string' or length(c->>'notes') > 5000 then raise exception 'invalid_import_notes'; end if;
      note := c->>'notes';
    end if;
    if exists(select 1 from public.contacts existing where existing.user_id = p_owner
      and public.google_contact_matches(existing.name, existing.email, n, e)) then
      skipped := skipped + 1;
    else
      insert into public.contacts(user_id, name, email, category, interests, notes)
        values (p_owner, n, e, cat, tags, note);
      added := added + 1;
    end if;
  end loop;
  return jsonb_build_object('added', added, 'skipped', skipped);
end;
$$;
revoke all on function public.import_google_contacts(text, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_google_contacts(text, uuid, text, uuid, jsonb) to service_role;

-- Schedule this at least every 15 minutes using the deployment's supported
-- scheduler. No pg_cron installation or scheduling is performed by this file.
create function public.cleanup_google_connector_sessions() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from public.google_connector_sessions where expires_at <= now();
$$;
revoke all on function public.cleanup_google_connector_sessions() from public, anon, authenticated;
grant execute on function public.cleanup_google_connector_sessions() to service_role;
