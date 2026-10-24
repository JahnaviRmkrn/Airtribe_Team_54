-- Review fixes: atomic interaction recording, and room-state rules enforced in
-- the database so joins, guest edits and votes cannot race a close/confirm.

-- Record an interaction and update the contact's dates in one transaction.
-- security invoker: runs as the caller, so RLS still scopes it to their contacts.
create function public.record_interaction(
  p_contact_id uuid,
  p_occurred_at timestamptz,
  p_type text,
  p_notes text,
  p_next_followup_at timestamptz,
  p_set_next boolean  -- true when the caller passed next_followup_at (may be null to clear)
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  c public.contacts;
  i public.interactions;
  is_latest boolean;
begin
  select * into c from public.contacts where id = p_contact_id for update;
  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  insert into public.interactions (user_id, contact_id, occurred_at, type, notes)
  values (c.user_id, c.id, p_occurred_at, p_type, p_notes)
  returning * into i;

  is_latest := c.last_interaction_at is null or p_occurred_at > c.last_interaction_at;

  update public.contacts set
    last_interaction_at = case when is_latest then p_occurred_at else last_interaction_at end,
    next_followup_at = case
      when p_set_next then p_next_followup_at
      when is_latest and preferred_frequency_days is not null
        then p_occurred_at + make_interval(days => preferred_frequency_days)
      else next_followup_at
    end
  where id = c.id
  returning * into c;

  return jsonb_build_object('interaction', to_jsonb(i), 'contact', to_jsonb(c));
end $$;

grant execute on function public.record_interaction(uuid, timestamptz, text, text, timestamptz, boolean) to authenticated;

-- Guests can only join/edit while the room is open and unexpired, and a room
-- holds at most 50 guests. Locking the meetup row serialises these writes with
-- each other and with the organiser's close/confirm (which update that row).
create function public.check_attendee_room() returns trigger language plpgsql as $$
declare m public.meetups;
begin
  select * into m from public.meetups where id = new.meetup_id for update;
  if not found or m.status <> 'open' or m.expires_at < now() then
    raise exception 'room_closed' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.meetup_attendees where meetup_id = new.meetup_id) >= 50 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger attendees_room_open before insert or update on public.meetup_attendees
  for each row execute function public.check_attendee_room();

-- Votes: attendee must belong to the meetup, room must be open and unexpired,
-- and voting stops once the organiser has confirmed a venue.
create or replace function public.check_vote_attendee() returns trigger language plpgsql as $$
declare m public.meetups;
begin
  select * into m from public.meetups where id = new.meetup_id for update;
  if not found or m.status <> 'open' or m.expires_at < now() then
    raise exception 'room_closed' using errcode = 'P0001';
  end if;
  if m.final_venue_id is not null then
    raise exception 'venue_confirmed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.meetup_attendees a where a.id = new.attendee_id and a.meetup_id = new.meetup_id) then
    raise exception 'attendee not in meetup';
  end if;
  return new;
end $$;
