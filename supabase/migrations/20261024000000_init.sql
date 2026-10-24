-- Personal Relationship Manager MVP: core schema + row-level security.
-- Private data (contacts, interactions, goals, meetups) is scoped to auth.uid().
-- Guest/room data (attendees, votes) is never exposed to anon via RLS; the
-- public room API reads and writes it server-side with the service role key.

create extension if not exists pgcrypto;

create type life_category as enum ('personal', 'professional', 'community');
create type meetup_status as enum ('open', 'closed');

-- Contacts -------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  category life_category not null,
  interests text[] not null default '{}',
  notes text,
  preferred_frequency_days int check (preferred_frequency_days between 1 and 365),
  last_interaction_at timestamptz,
  next_followup_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_user_idx on public.contacts (user_id, category);
create index contacts_followup_idx on public.contacts (user_id, next_followup_at);

-- Interactions ---------------------------------------------------------------
create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  type text not null default 'check_in' check (type in ('check_in', 'call', 'message', 'meetup', 'other')),
  notes text check (length(notes) <= 2000),
  created_at timestamptz not null default now()
);
create index interactions_user_idx on public.interactions (user_id, occurred_at desc);

-- Balance goals (one row per user per category; app enforces sum = 100) -------
create table public.balance_goals (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category life_category not null,
  target_percentage int not null check (target_percentage between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

-- Venues (seeded sample data, shared read-only catalogue) ---------------------
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  area text not null,
  city text not null default 'Bengaluru',
  activity_types text[] not null default '{}',  -- dinner, coffee, drinks, activity, brunch
  tags text[] not null default '{}',            -- cuisine / vibe / activity tags
  price_per_person int,                         -- approximate INR, sample only
  details text,
  source_type text not null default 'sample' check (source_type in ('sample', 'organizer', 'verified'))
);

-- Meetups --------------------------------------------------------------------
create table public.meetups (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 120),
  activity text not null default 'dinner',
  area text,
  starts_at timestamptz,
  budget int check (budget >= 0),
  status meetup_status not null default 'open',
  -- 32 random bytes, base64url: unguessable room token
  room_token text not null unique default
    rtrim(translate(encode(gen_random_bytes(32), 'base64'), '+/', '-_'), '='),
  expires_at timestamptz not null default (now() + interval '14 days'),
  final_venue_id uuid references public.venues (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meetups_organizer_idx on public.meetups (organizer_id, starts_at);

-- Attendees (guests, no account) ---------------------------------------------
create table public.meetup_attendees (
  id uuid primary key default gen_random_uuid(),
  meetup_id uuid not null references public.meetups (id) on delete cascade,
  guest_name text not null check (length(trim(guest_name)) between 1 and 60),
  preferences jsonb not null default '{}',
  availability jsonb not null default '[]',
  secret_hash text not null,  -- sha256 of the guest's cookie secret
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index attendees_meetup_idx on public.meetup_attendees (meetup_id, joined_at);

-- Votes: one per attendee per meetup (re-voting replaces it) ------------------
create table public.venue_votes (
  id uuid primary key default gen_random_uuid(),
  meetup_id uuid not null references public.meetups (id) on delete cascade,
  attendee_id uuid not null references public.meetup_attendees (id) on delete cascade,
  venue_id uuid not null references public.venues (id),
  created_at timestamptz not null default now(),
  unique (meetup_id, attendee_id)
);

-- Saved discovery links (P1-lite, manual) -------------------------------------
create table public.saved_discoveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  url text,
  type text,
  interests text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- updated_at triggers --------------------------------------------------------
create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();
create trigger meetups_touch before update on public.meetups
  for each row execute function public.touch_updated_at();
create trigger attendees_touch before update on public.meetup_attendees
  for each row execute function public.touch_updated_at();

-- Interaction must belong to a contact the same user owns
create function public.check_interaction_owner() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.contacts c where c.id = new.contact_id and c.user_id = new.user_id) then
    raise exception 'contact not found';
  end if;
  return new;
end $$;
create trigger interactions_owner before insert or update on public.interactions
  for each row execute function public.check_interaction_owner();

-- Vote must reference an attendee of the same meetup
create function public.check_vote_attendee() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.meetup_attendees a where a.id = new.attendee_id and a.meetup_id = new.meetup_id) then
    raise exception 'attendee not in meetup';
  end if;
  return new;
end $$;
create trigger votes_attendee before insert or update on public.venue_votes
  for each row execute function public.check_vote_attendee();

-- Row-level security ---------------------------------------------------------
alter table public.contacts enable row level security;
alter table public.interactions enable row level security;
alter table public.balance_goals enable row level security;
alter table public.venues enable row level security;
alter table public.meetups enable row level security;
alter table public.meetup_attendees enable row level security;
alter table public.venue_votes enable row level security;
alter table public.saved_discoveries enable row level security;

create policy own_contacts on public.contacts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_interactions on public.interactions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_goals on public.balance_goals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_discoveries on public.saved_discoveries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_meetups on public.meetups for all to authenticated
  using (organizer_id = auth.uid()) with check (organizer_id = auth.uid());

create policy venues_read on public.venues for select to authenticated using (true);

-- Organizer can read attendees/votes of their own meetups. No anon policies:
-- guests go through the server-side room API.
create policy organizer_reads_attendees on public.meetup_attendees for select to authenticated
  using (exists (select 1 from public.meetups m where m.id = meetup_id and m.organizer_id = auth.uid()));
create policy organizer_reads_votes on public.venue_votes for select to authenticated
  using (exists (select 1 from public.meetups m where m.id = meetup_id and m.organizer_id = auth.uid()));

-- Realtime: clients subscribe to these as a "something changed, refetch the
-- room" signal (organizer via RLS). Guests should poll GET /api/rooms/:token.
alter publication supabase_realtime add table public.meetup_attendees, public.venue_votes;
