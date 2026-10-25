-- Optional email per contact, for "Email" hand-off links and the voice assistant.
alter table public.contacts
  add column if not exists email text
  check (email is null or (length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'));
