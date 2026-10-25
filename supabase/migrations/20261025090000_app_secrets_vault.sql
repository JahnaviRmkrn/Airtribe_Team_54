-- App API keys live in Supabase Vault instead of committed env files.
-- The server reads them once at boot (instrumentation.ts -> lib/secrets.ts)
-- with the service-role key; scripts/push-secrets.mjs writes them.
-- Only service_role can call either function: anon/authenticated get nothing.
create extension if not exists supabase_vault with schema vault;

create or replace function public.app_secrets(names text[])
returns table (name text, secret text)
language sql
security definer
set search_path = ''
as $$
  select s.name, s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = any(names);
$$;

create or replace function public.set_app_secret(secret_name text, secret_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  select id into existing from vault.secrets where name = secret_name;
  if existing is null then
    perform vault.create_secret(secret_value, secret_name, 'muop app secret');
  else
    perform vault.update_secret(existing, secret_value);
  end if;
end;
$$;

revoke all on function public.app_secrets(text[]) from public, anon, authenticated;
revoke all on function public.set_app_secret(text, text) from public, anon, authenticated;
grant execute on function public.app_secrets(text[]) to service_role;
grant execute on function public.set_app_secret(text, text) to service_role;
