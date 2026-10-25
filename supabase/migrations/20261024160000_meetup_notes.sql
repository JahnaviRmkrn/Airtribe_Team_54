-- Organiser's planning note for a meetup (e.g. the summary the voice planner
-- writes: who's coming, what they want, anything to remember). Organiser-only:
-- it is not part of the public room view.
alter table public.meetups
  add column if not exists notes text check (notes is null or length(notes) <= 2000);
