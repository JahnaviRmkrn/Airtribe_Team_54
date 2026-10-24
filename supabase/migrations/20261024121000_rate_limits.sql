-- Rate limits for the public room API. Fixed windows counted in Postgres so
-- they hold across serverless instances (no in-memory state on Vercel).
-- Only the service role (server-side room API) can touch this.

create table public.rate_limits (
  key text not null,              -- bucket:ip[:room token]
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);
create index rate_limits_window_idx on public.rate_limits (window_start);

-- RLS on with no policies: anon/authenticated see nothing.
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

-- Counts one hit against p_key in the current window; true = allowed.
-- Atomic: the upsert takes a row lock, so concurrent hits serialise.
create function public.hit_rate_limit(p_key text, p_window_seconds int, p_max int) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  w timestamptz;
  n int;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be > 0';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits as r (key, window_start, count) values (p_key, w, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into n;

  -- Opportunistic cleanup: ~1 in 100 calls drops windows older than a day
  -- (longest window is an hour). Indexed range delete, so cheap.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return n <= p_max;
end $$;

revoke execute on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;
