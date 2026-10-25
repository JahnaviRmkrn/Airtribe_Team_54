-- Social-graph import: where a contact came from (LinkedIn Connections.csv,
-- Facebook friends, WhatsApp) plus the work details those exports carry.
-- All columns are nullable; existing rows keep source = null.
alter table public.contacts
  add column if not exists source text
    check (source is null or source in ('manual', 'linkedin', 'facebook', 'whatsapp', 'vcard', 'google', 'android')),
  add column if not exists source_ref text check (source_ref is null or length(source_ref) <= 300),
  add column if not exists company text check (company is null or length(company) <= 200),
  add column if not exists position text check (position is null or length(position) <= 200);

-- E.164 phone (e.g. +919876543210). Also added by the WhatsApp import, hence if not exists.
alter table public.contacts
  add column if not exists phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');

-- Re-importing the same export must not duplicate people: one row per
-- (owner, source, profile URL / Facebook id).
create unique index if not exists contacts_source_ref_uniq
  on public.contacts (user_id, source, source_ref)
  where source_ref is not null;

-- Bulk insert for imports. security invoker: runs as the caller, so RLS still
-- scopes every row to auth.uid(). Rows that carry a source_ref already imported
-- are refreshed (company/position filled in, email only if missing) instead of
-- duplicated. p_rows: [{ name, email, phone, source_ref, company, position, notes }].
create function public.import_contacts(p_source text, p_category text, p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  n_new int;
  n_upd int;
begin
  if p_source not in ('linkedin', 'facebook', 'whatsapp', 'vcard', 'google', 'android') then
    raise exception 'bad source' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'p_rows must be an array of at most 1000' using errcode = '22023';
  end if;

  with r as (
    select * from jsonb_to_recordset(p_rows)
      as x(name text, email text, phone text, source_ref text, company text, position text, notes text)
  ), up as (
    insert into public.contacts as c (user_id, name, category, email, phone, notes, source, source_ref, company, position)
    select auth.uid(), r.name, p_category::life_category, r.email, r.phone, r.notes, p_source, r.source_ref, r.company, r.position
    from r
    on conflict (user_id, source, source_ref) where source_ref is not null
    do update set
      company = coalesce(excluded.company, c.company),
      position = coalesce(excluded.position, c.position),
      email = coalesce(c.email, excluded.email),
      phone = coalesce(c.phone, excluded.phone),
      updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into n_new, n_upd from up;

  return jsonb_build_object('inserted', n_new, 'updated', n_upd);
end $$;
grant execute on function public.import_contacts(text, text, jsonb) to authenticated;

-- Facebook friends fetched from the Graph API at sign-in wait here (never the
-- provider token itself) until the user reviews and imports or dismisses them.
create table public.contact_import_stage (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source text not null check (source in ('facebook', 'google')),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  created_at timestamptz not null default now(),
  primary key (user_id, source)
);
alter table public.contact_import_stage enable row level security;
create policy own_import_stage on public.contact_import_stage for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
