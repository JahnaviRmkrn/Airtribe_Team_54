-- Found by the TLA+ model (spec/MeetupRoom.tla): a vote withdrawal could pass
-- the API's open-room check, then commit after the organiser closed the room.
-- Guard DELETEs on votes the same way inserts/updates are guarded.
create function public.check_vote_delete() returns trigger language plpgsql as $$
declare m public.meetups;
begin
  select * into m from public.meetups where id = old.meetup_id for update;
  -- Not found: the meetup itself is being deleted and this is the cascade.
  if found and (m.status <> 'open' or m.expires_at < now()) then
    raise exception 'room_closed' using errcode = 'P0001';
  end if;
  return old;
end $$;

create trigger votes_room_open_delete before delete on public.venue_votes
  for each row execute function public.check_vote_delete();
