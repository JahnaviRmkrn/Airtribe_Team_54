-- Read-only capability discovery for partial installations. Apply only through
-- the approved operator process, after the migrations for the intended purpose.
-- This does not install missing capabilities, access Vault, touch receipts,
-- grant Google scopes, or enable Gmail/Calendar feature flags.
create function public.google_connector_purpose_ready(p_purpose text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  routines text[] := array[
    'public.claim_google_connector_session(text,uuid,text,uuid)',
    'public.replace_google_connector_session(text,uuid,text,text,timestamp with time zone)',
    'public.cleanup_google_connector_sessions()'
  ];
  tables jsonb := '{"public.google_connector_sessions":["id","user_id","purpose","encrypted_payload","expires_at","lease","locked_until","protected_action"]}';
  routine text; routine_oid oid; table_name text; columns jsonb; table_oid oid;
  private_tables text[] := array['public.google_connector_sessions'];
begin
  -- A new purpose never inherits another purpose's readiness by default.
  if p_purpose is null or p_purpose not in ('contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar') then return false; end if;

  if p_purpose in ('contacts', 'sheets-import', 'sheets-export') then
    tables := tables || '{"public.contacts":["id","user_id","name","email","category","interests","notes"]}'::jsonb;
  end if;
  if p_purpose in ('contacts', 'sheets-import') then
    routines := routines || array[
      'public.google_contact_matches(text,text,text,text)',
      'public.preview_google_contact_duplicates(uuid,jsonb)',
      'public.import_google_contacts(text,uuid,text,uuid,jsonb)'
    ];
  end if;
  if p_purpose = 'contacts' then
    routines := array_append(routines, 'public.hit_rate_limit(text,integer,integer)');
    tables := tables || '{"public.rate_limits":["key","window_start","count"]}'::jsonb;
  end if;
  if p_purpose in ('gmail', 'calendar') then
    tables := tables || '{"public.google_confirmed_actions":["id","user_id","purpose","session_id","preview_hash","encrypted_preview","state","provider_ref","created_at","expires_at","claimed_at","finished_at"]}'::jsonb;
    private_tables := array_append(private_tables, 'public.google_confirmed_actions');
    routines := routines || array[
      'public.create_google_action_preview(uuid,uuid,text,text,uuid,text,text)',
      'public.claim_google_confirmed_action(uuid,uuid,text,text,uuid,text)',
      'public.cleanup_google_confirmed_actions()'
    ];
    -- Merely finding the action table/functions is not enough: the immutable
    -- preview and no-replay state transition trigger must be attached/enabled.
    if not exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('public.google_confirmed_actions')
        and tgname = 'google_action_transition' and not tgisinternal
        and tgfoid = to_regprocedure('public.guard_google_action_transition()')
        and tgenabled in ('O', 'A') and tgtype = 19 and tgattr::text = '' and tgqual is null
    ) then return false; end if;
  end if;

  -- Catalog lookup only: never invoke a routine to test it. No session claims,
  -- rate-limit hits, imports, cleanup or provider actions happen during a probe.
  foreach routine in array routines loop
    routine_oid := to_regprocedure(routine);
    if routine_oid is null then return false; end if;
    if not has_function_privilege('service_role', routine_oid, 'EXECUTE')
      or has_function_privilege('anon', routine_oid, 'EXECUTE')
      or has_function_privilege('authenticated', routine_oid, 'EXECUTE') then return false; end if;
  end loop;
  for table_name, columns in select key, value from jsonb_each(tables) loop
    table_oid := to_regclass(table_name);
    if table_oid is null then return false; end if;
    if not exists (select 1 from pg_class where oid = table_oid and relkind in ('r', 'p') and relrowsecurity) then return false; end if;
    if exists (
      select 1 from jsonb_array_elements_text(columns) required(name)
      where not exists (select 1 from pg_attribute where attrelid = table_oid and attname = required.name and attnum > 0 and not attisdropped)
    ) then return false; end if;
    if table_name = any(private_tables) then
      if not has_table_privilege('service_role', table_oid, 'SELECT')
        or not has_table_privilege('service_role', table_oid, 'INSERT')
        or not has_table_privilege('service_role', table_oid, 'UPDATE')
        or has_table_privilege('anon', table_oid, 'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('authenticated', table_oid, 'SELECT,INSERT,UPDATE,DELETE') then return false; end if;
      if table_name = 'public.google_connector_sessions' and not has_table_privilege('service_role', table_oid, 'DELETE') then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.google_connector_purpose_ready(text) from public, anon, authenticated;
grant execute on function public.google_connector_purpose_ready(text) to service_role;
comment on function public.google_connector_purpose_ready(text) is
  'Read-only service-only purpose prerequisite check. False or a failed probe is not permission to reconnect, retry writes, or erase action receipts.';
