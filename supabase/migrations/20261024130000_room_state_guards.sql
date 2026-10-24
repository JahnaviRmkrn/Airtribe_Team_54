-- Keep organizer writes consistent with the room model and payment accounting.
-- UPDATE already locks the meetup row, so this checks the committed state even
-- when a close and confirmation race. Confirmed venues cannot be replaced.
create function public.check_meetup_transition() returns trigger language plpgsql as $$
begin
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'room_closed' using errcode = 'P0001';
  end if;
  if new.final_venue_id is distinct from old.final_venue_id then
    if old.status <> 'open' or old.expires_at < now() then
      raise exception 'room_closed' using errcode = 'P0001';
    end if;
    if old.final_venue_id is not null then
      raise exception 'venue_confirmed' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger meetups_state_transition before update on public.meetups
  for each row execute function public.check_meetup_transition();

-- Withdrawal is a vote change too. Keep the existing row lock and allow the
-- parent meetup deletion to cascade, but never change confirmed vote totals.
create or replace function public.check_vote_delete() returns trigger language plpgsql as $$
declare m public.meetups;
begin
  select * into m from public.meetups where id = old.meetup_id for update;
  if found then
    if m.status <> 'open' or m.expires_at < now() then
      raise exception 'room_closed' using errcode = 'P0001';
    end if;
    if m.final_venue_id is not null then
      raise exception 'venue_confirmed' using errcode = 'P0001';
    end if;
  end if;
  return old;
end $$;
