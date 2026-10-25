-- Optional confirmed Gmail / Calendar actions. Apply only with operator approval.
-- No provider calls, grants, schedules or credentials are created here.
create table public.google_confirmed_actions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('gmail', 'calendar')),
  session_id text not null check (session_id ~ '^[a-f0-9]{64}$'),
  preview_hash text not null check (preview_hash ~ '^[a-f0-9]{64}$'),
  encrypted_preview text,
  state text not null default 'preview' check (state in ('preview', 'claimed', 'completed', 'uncertain', 'rejected', 'cancelled', 'expired')),
  provider_ref text check (length(provider_ref) <= 1024),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  finished_at timestamptz
);
create index google_actions_owner_idx on public.google_confirmed_actions(user_id, purpose, created_at desc);
create index google_actions_fingerprint_idx on public.google_confirmed_actions(user_id, purpose, preview_hash);
alter table public.google_confirmed_actions enable row level security;
revoke all on public.google_confirmed_actions from public, anon, authenticated;
grant select, insert, update on public.google_confirmed_actions to service_role;

create function public.guard_google_action_transition() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.id, new.user_id, new.purpose, new.session_id, new.preview_hash, new.created_at, new.expires_at)
    is distinct from (old.id, old.user_id, old.purpose, old.session_id, old.preview_hash, old.created_at, old.expires_at) then raise exception 'immutable_google_preview'; end if;
  if new.encrypted_preview is distinct from old.encrypted_preview and not
    (new.encrypted_preview is null and old.created_at < now() - interval '7 days') then raise exception 'immutable_google_preview'; end if;
  if new.state <> old.state and not (
    (old.state = 'preview' and new.state in ('claimed', 'cancelled', 'expired')) or
    (old.state = 'claimed' and new.state in ('completed', 'uncertain', 'rejected')) or
    (old.state = 'uncertain' and new.state = 'completed')
  ) then raise exception 'invalid_google_action_transition'; end if;
  return new;
end;
$$;
create trigger google_action_transition before update on public.google_confirmed_actions
for each row execute function public.guard_google_action_transition();
revoke all on function public.guard_google_action_transition() from public, anon, authenticated;

-- A retry of preview creation returns the same row. Editing cancels older
-- unclaimed previews. Unknown writes block another identical intent even after
-- the short-lived connection expires or the user reconnects.
create function public.create_google_action_preview(p_id uuid, p_owner uuid, p_purpose text, p_session text, p_lease uuid, p_hash text, p_preview text)
returns setof public.google_confirmed_actions
language plpgsql security definer set search_path = public, pg_temp as $$
declare session_expiry timestamptz; existing public.google_confirmed_actions%rowtype;
begin
  if p_purpose not in ('gmail', 'calendar') or p_hash !~ '^[a-f0-9]{64}$' or p_preview is null or length(p_preview) > 200000 then raise exception 'invalid_google_preview'; end if;
  select expires_at into session_expiry from public.google_connector_sessions
    where id = p_session and user_id = p_owner and purpose = p_purpose and lease = p_lease and locked_until > now() and expires_at > now() for update;
  if not found then raise exception 'connector_expired'; end if;
  perform pg_advisory_xact_lock(hashtextextended('google-action:' || p_owner::text || ':' || p_purpose, 0));
  select * into existing from public.google_confirmed_actions where user_id = p_owner and purpose = p_purpose and preview_hash = p_hash
    and (state in ('claimed', 'uncertain') or (session_id = p_session and (state = 'completed' or (state = 'preview' and expires_at > now()))))
    order by created_at desc limit 1;
  if found then return next existing; return; end if;
  update public.google_confirmed_actions set state = 'cancelled', finished_at = now()
    where user_id = p_owner and purpose = p_purpose and state = 'preview';
  return query insert into public.google_confirmed_actions(id,user_id,purpose,session_id,preview_hash,encrypted_preview,expires_at)
    values(p_id,p_owner,p_purpose,p_session,p_hash,p_preview,least(session_expiry, now() + interval '10 minutes')) returning *;
end;
$$;
revoke all on function public.create_google_action_preview(uuid,uuid,text,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_google_action_preview(uuid,uuid,text,text,uuid,text,text) to service_role;

-- A durable, ONE-TIME claim. There is intentionally no lease expiry, reclaim,
-- reset or retry transition for provider writes. The session is not an FK:
-- deleting OAuth tokens never deletes this replay tombstone.
create function public.claim_google_confirmed_action(p_id uuid, p_owner uuid, p_purpose text, p_session text, p_lease uuid, p_hash text)
returns setof public.google_confirmed_actions
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.google_connector_sessions where id = p_session and user_id = p_owner and purpose = p_purpose
    and lease = p_lease and locked_until > now() and expires_at > now() for update;
  if not found then raise exception 'connector_expired'; end if;
  return query update public.google_confirmed_actions set state = 'claimed', claimed_at = now()
    where id = p_id and user_id = p_owner and purpose = p_purpose and session_id = p_session and preview_hash = p_hash
    and state = 'preview' and encrypted_preview is not null and expires_at > now() returning *;
end;
$$;
revoke all on function public.claim_google_confirmed_action(uuid,uuid,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_google_confirmed_action(uuid,uuid,text,text,uuid,text) to service_role;

-- Operator may schedule cleanup. Preserve compact action tombstones indefinitely
-- (until account deletion) while deleting encrypted message/event contents after
-- seven days. Stale claimed rows remain non-replayable, not automatically retried.
create function public.cleanup_google_confirmed_actions() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.google_confirmed_actions set state = 'expired', finished_at = now() where state = 'preview' and expires_at <= now();
  update public.google_confirmed_actions set encrypted_preview = null where created_at < now() - interval '7 days' and encrypted_preview is not null;
$$;
revoke all on function public.cleanup_google_confirmed_actions() from public, anon, authenticated;
grant execute on function public.cleanup_google_confirmed_actions() to service_role;
