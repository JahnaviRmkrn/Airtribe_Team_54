-- Linked messaging channels per organiser: WhatsApp (linked device, held by
-- the local bridge service) and SMS (Android gateway app). Opt-in only: a row
-- exists only after the organiser accepted the warning (consented_at).
--
-- Service role only. RLS is on with no policies and the table is revoked from
-- anon/authenticated, so the browser can never read it. secret_enc holds
-- AES-256-GCM sealed gateway credentials (SMS); WhatsApp session data never
-- touches the database, it lives encrypted in the bridge's session dir.

create table public.channel_links (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('whatsapp', 'sms')),
  status text not null default 'unlinked'
    check (status in ('unlinked', 'connecting', 'waiting_qr', 'connected', 'logged_out', 'error')),
  mode text check (mode is null or mode in ('cloud', 'local')),  -- sms only
  secret_enc text,                                               -- sms only: sealed {url?, username, password}
  last_error text,
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

alter table public.channel_links enable row level security;
revoke all on public.channel_links from anon, authenticated;

-- Contacts imported from messaging apps. These columns are also added by the
-- social-graph import migration; every statement here is guarded so the two
-- can land in either order.
alter table public.contacts add column if not exists phone text
  check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');
alter table public.contacts add column if not exists source text not null default 'manual';
alter table public.contacts add column if not exists source_ref text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contacts'::regclass and conname = 'contacts_source_check'
  ) and not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.contacts'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%whatsapp%'
  ) then
    alter table public.contacts add constraint contacts_source_check
      check (source in ('manual', 'linkedin', 'facebook', 'whatsapp'));
  end if;
end $$;

-- One imported contact per (user, source, external id): re-importing is a no-op.
create unique index if not exists contacts_source_ref_uniq
  on public.contacts (user_id, source, source_ref) where source_ref is not null;
