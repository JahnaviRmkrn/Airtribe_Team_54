-- Session replacement is a server-side owner/purpose operation, not a cookie
-- operation. A second browser without the opaque cookie must not erase a live
-- action or its uncertain result. No provider access is enabled by this file.
alter table public.google_connector_sessions
  add column protected_action boolean not null default false;
-- Existing ciphertext cannot be classified safely during an upgrade. Protect
-- every live pre-migration session until explicit disconnect/original expiry.
update public.google_connector_sessions set protected_action = true
  where expires_at > now();

create function public.replace_google_connector_session(
  p_id text, p_owner uuid, p_purpose text, p_payload text, p_expires_at timestamptz
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare existing public.google_connector_sessions%rowtype;
begin
  if p_id is null or p_id !~ '^[a-f0-9]{64}$' or p_owner is null
    or p_purpose is null or length(p_purpose) > 64
    or p_payload is null or octet_length(p_payload) not between 1 and 2000000
    or p_expires_at is null or p_expires_at <= now()
    or p_expires_at > now() + interval '15 minutes' then
    raise exception 'invalid_connector_session';
  end if;
  -- Also serialize two initial inserts when no row exists yet. Claims and
  -- checkpoints serialize against the SELECT FOR UPDATE on an existing row.
  perform pg_advisory_xact_lock(hashtextextended('google-session-replacement:' || p_owner::text || ':' || p_purpose, 0));
  select * into existing from public.google_connector_sessions
    where user_id = p_owner and purpose = p_purpose for update;
  if found then
    -- An active lease is never replaced, including the tiny interval between
    -- acquisition and checkpointing the action's durable intent.
    if existing.locked_until > now() then raise exception 'connector_busy'; end if;
    if existing.expires_at > now() and existing.protected_action then
      raise exception 'connector_action_pending';
    end if;
    update public.google_connector_sessions set
      id = p_id, encrypted_payload = p_payload, expires_at = p_expires_at,
      lease = null, locked_until = null, protected_action = false
      where id = existing.id;
  else
    insert into public.google_connector_sessions(id, user_id, purpose, encrypted_payload, expires_at)
      values(p_id, p_owner, p_purpose, p_payload, p_expires_at);
  end if;
end;
$$;
revoke all on function public.replace_google_connector_session(text, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.replace_google_connector_session(text, uuid, text, text, timestamptz) to service_role;

comment on column public.google_connector_sessions.protected_action is
  'Set with a leased action checkpoint; never cleared by save/unlock. Explicit disconnect or original expiry is required before replacement.';

-- A read-only capability probe keeps old/partial operator setup from looking
-- ready. Ordinary authenticated users cannot inspect connector infrastructure.
create function public.google_connector_session_ready() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select to_regprocedure('public.replace_google_connector_session(text,uuid,text,text,timestamp with time zone)') is not null
    and exists(select 1 from pg_attribute where attrelid = 'public.google_connector_sessions'::regclass
      and attname = 'protected_action' and not attisdropped);
$$;
revoke all on function public.google_connector_session_ready() from public, anon, authenticated;
grant execute on function public.google_connector_session_ready() to service_role;
