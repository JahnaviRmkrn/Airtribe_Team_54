-- Durable manual-create receipts. Apply through the normal reviewed migration
-- process, never from a test or application startup. Google import is separate.
create table public.contact_create_intents (
  user_id uuid not null references auth.users(id) on delete cascade,
  intent_id uuid not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  contact_ids uuid[] not null check (cardinality(contact_ids) between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (user_id, intent_id)
);
alter table public.contact_create_intents enable row level security;
revoke all on public.contact_create_intents from public, anon, authenticated;
grant select on public.contact_create_intents to authenticated;
create policy contact_create_receipts_owner on public.contact_create_intents
  for select to authenticated using (user_id = auth.uid());

-- No caller-supplied owner: bind directly to the authenticated JWT. The definer
-- is needed only for append-only receipts, whose writes are not client-granted.
create function public.create_contacts_once(p_intent uuid, p_contacts jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  owner_id uuid := auth.uid();
  previous public.contact_create_intents%rowtype;
  c jsonb; field text; tags text[]; created public.contacts%rowtype;
  created_ids uuid[] := '{}';
  request_hash text; result jsonb;
begin
  if owner_id is null then raise exception 'contact_auth_required' using errcode = '42501'; end if;
  if p_intent is null then raise exception 'invalid_contact_intent'; end if;
  if p_contacts is null or jsonb_typeof(p_contacts) <> 'array' then raise exception 'invalid_contact_batch'; end if;
  if jsonb_array_length(p_contacts) not between 1 and 5 or octet_length(p_contacts::text) > 100000 then
    raise exception 'invalid_contact_batch';
  end if;

  request_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_contacts::text, 'UTF8')), 'hex');

  -- Serialize the same owner+intent even before its receipt exists. The primary
  -- key is a second invariant; inserts and the immutable receipt commit together.
  perform pg_advisory_xact_lock(hashtextextended('contact-create:' || owner_id::text || ':' || p_intent::text, 0));
  select * into previous from public.contact_create_intents
    where user_id = owner_id and intent_id = p_intent;
  if found then
    if previous.request_digest <> request_hash then raise exception 'contact_intent_conflict' using errcode = '23505'; end if;
    created_ids := previous.contact_ids;
  else
  for c in select value from jsonb_array_elements(p_contacts) loop
    if jsonb_typeof(c) <> 'object' then raise exception 'invalid_contact'; end if;
    if exists(select 1 from jsonb_object_keys(c) k where k not in
      ('name','category','interests','notes','email','preferred_frequency_days','last_interaction_at','next_followup_at')) then
      raise exception 'invalid_contact_field';
    end if;
    if jsonb_typeof(c->'name') is distinct from 'string' or length(btrim(c->>'name')) not between 1 and 120 or c->>'name' !~ '[^[:space:]]'
      or jsonb_typeof(c->'category') is distinct from 'string' or c->>'category' not in ('personal','professional','community') then
      raise exception 'invalid_contact';
    end if;
    tags := '{}';
    if c ? 'interests' then
      if jsonb_typeof(c->'interests') <> 'array' then raise exception 'invalid_contact_interests'; end if;
      if jsonb_array_length(c->'interests') > 20 then raise exception 'invalid_contact_interests'; end if;
      if exists(select 1 from jsonb_array_elements(c->'interests') v where jsonb_typeof(v) <> 'string'
        or length(btrim(v #>> '{}')) not between 1 and 40 or (v #>> '{}') !~ '[^[:space:]]') then raise exception 'invalid_contact_interests'; end if;
      select coalesce(array_agg(btrim(v)), '{}') into tags from jsonb_array_elements_text(c->'interests') v;
    end if;
    if c ? 'notes' and c->'notes' <> 'null'::jsonb and
      (jsonb_typeof(c->'notes') <> 'string' or length(c->>'notes') > 5000) then raise exception 'invalid_contact_notes'; end if;
    if c ? 'email' and c->'email' <> 'null'::jsonb and
      (jsonb_typeof(c->'email') <> 'string' or length(c->>'email') > 254
        or c->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'invalid_contact_email'; end if;
    if c ? 'preferred_frequency_days' and c->'preferred_frequency_days' <> 'null'::jsonb then
      if jsonb_typeof(c->'preferred_frequency_days') <> 'number' or c->>'preferred_frequency_days' !~ '^[0-9]+$' then
        raise exception 'invalid_contact_frequency';
      end if;
      if (c->>'preferred_frequency_days')::numeric not between 1 and 365 then raise exception 'invalid_contact_frequency'; end if;
    end if;
    foreach field in array array['last_interaction_at','next_followup_at'] loop
      if c ? field and c->field <> 'null'::jsonb then
        if jsonb_typeof(c->field) <> 'string' or c->>field !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
          raise exception 'invalid_contact_date';
        end if;
        perform (c->>field)::timestamptz;
      end if;
    end loop;
    insert into public.contacts(user_id,name,category,interests,notes,email,preferred_frequency_days,last_interaction_at,next_followup_at)
      values(owner_id,btrim(c->>'name'),(c->>'category')::public.life_category,tags,c->>'notes',c->>'email',
        (c->>'preferred_frequency_days')::int,(c->>'last_interaction_at')::timestamptz,(c->>'next_followup_at')::timestamptz)
      returning * into created;
    created_ids := array_append(created_ids, created.id);
  end loop;
  insert into public.contact_create_intents(user_id,intent_id,request_digest,contact_ids)
    values(owner_id,p_intent,request_hash,created_ids);
  end if;
  -- Keep only a digest and IDs durably. Replays return current owned records,
  -- not retained private snapshots. Deleted IDs remain compact tombstones so
  -- retrying an old create cannot resurrect a deleted person or their notes.
  select jsonb_build_object(
    'contacts', coalesce(jsonb_agg(to_jsonb(current_contact) order by saved.position) filter (where current_contact.id is not null), '[]'::jsonb),
    'created_ids', to_jsonb(created_ids),
    'missing_ids', coalesce(jsonb_agg(saved.id order by saved.position) filter (where current_contact.id is null), '[]'::jsonb)
  ) into result
  from unnest(created_ids) with ordinality saved(id, position)
  left join public.contacts current_contact on current_contact.id = saved.id and current_contact.user_id = owner_id;
  return result;
end;
$$;
revoke all on function public.create_contacts_once(uuid,jsonb) from public, anon;
grant execute on function public.create_contacts_once(uuid,jsonb) to authenticated;
-- Keep receipts for the account lifetime. Deleting a contact does not delete its
-- compact receipt: retrying returns original IDs with current rows/deleted IDs,
-- never resurrects or overwrites data. Account deletion cascades. Do not
-- time-expire these keys, or a delayed retry could insert again.

-- Read-only capability probe. The server calls this only after an operator has
-- explicitly enabled CONTACT_CREATE_RETRY_ENABLED. It never creates a receipt,
-- touches contact data, or applies schema at runtime.
create function public.contact_create_retry_ready()
returns boolean language sql stable security invoker set search_path = pg_catalog, public as $$
  select auth.uid() is not null
    and coalesce(has_function_privilege(current_user,
      to_regprocedure('public.create_contacts_once(uuid,jsonb)'), 'EXECUTE'), false)
    and coalesce(has_table_privilege(current_user,
      to_regclass('public.contact_create_intents'), 'SELECT'), false);
$$;
revoke all on function public.contact_create_retry_ready() from public, anon;
grant execute on function public.contact_create_retry_ready() to authenticated;
