-- Additive rollout contract. Stop and drain older payment workers before applying.
-- Reinstall the final retry guard even if an earlier revision of the receipts
-- migration was already applied. Never rewrite a deployed migration in place.
create or replace function public.guard_unknown_payment_attempt() returns trigger language plpgsql as $$
begin
  -- Old versions clear a terminal order's ID without rotating its reference.
  -- That would make a new worker recover the OLD terminal receipt while the
  -- old worker creates another order. Require a genuinely unused reference.
  if old.status in ('failed', 'cancelled') and old.pine_order_id is not null
     and new.status = 'pending' and new.pine_order_id is null and (
       new.merchant_order_reference is null
       or btrim(new.merchant_order_reference) = ''
       or new.merchant_order_reference is not distinct from old.merchant_order_reference
       or exists (select 1 from public.meetup_payment_attempts a
         where a.merchant_order_reference = new.merchant_order_reference)
     ) then
    raise exception 'payment_retry_requires_fresh_reference';
  end if;
  if old.status = 'pending' and old.pine_order_id is null and (
    new.pine_order_id is null
    or new.merchant_order_reference is distinct from old.merchant_order_reference
    or new.amount_paise is distinct from old.amount_paise
  ) then
    raise exception 'payment_attempt_requires_reconciliation';
  end if;
  return new;
end $$;

-- An old binary must not create a new unreferenced claim after this upgrade.
-- This cannot protect a provider request that was already in flight: drain first.
create function public.guard_new_payment_attempt() returns trigger language plpgsql as $$
begin
  if new.merchant_order_reference is null or btrim(new.merchant_order_reference) = '' then
    raise exception 'payment_upgrade_required';
  end if;
  return new;
end $$;
create trigger payments_new_attempt before insert on public.meetup_payments
  for each row execute function public.guard_new_payment_attempt();

-- No data, provider IDs, references or operational details leave this probe.
-- Check each request, not a cached environment flag. Missing or disabled guards
-- must not advertise a safe checkout even if their tables happen to exist.
create function public.payment_checkout_ready() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select
    not exists (
      select 1 from (values
        ('meetup_payments', 'merchant_order_reference'),
        ('meetup_payment_attempts', 'merchant_order_reference'),
        ('meetup_payment_attempts', 'payment_id'),
        ('meetup_payment_attempts', 'amount_paise'),
        ('meetup_payment_attempts', 'state'),
        ('meetup_payment_attempts', 'pine_order_id'),
        ('meetup_payment_attempts', 'redirect_url'),
        ('meetup_payment_attempts', 'created_at')
      ) required(relation, field)
      where not exists (select 1 from pg_attribute
        where attrelid = to_regclass('public.' || required.relation)
          and attname = required.field and not attisdropped)
    )
    and not exists (
      select 1 from (values
        ('meetup_payments', 'payments_unknown_attempt', 'guard_unknown_payment_attempt()'),
        ('meetup_payments', 'payments_new_attempt', 'guard_new_payment_attempt()'),
        ('meetup_payments', 'payments_attendee', 'check_payment_attendee()'),
        ('meetup_payment_attempts', 'payment_attempts_receipt', 'check_payment_attempt_receipt()')
      ) required(relation, trigger_name, function_name)
      where not exists (select 1 from pg_trigger
        where tgrelid = to_regclass('public.' || required.relation)
          and tgname = required.trigger_name
          and tgfoid = to_regprocedure('public.' || required.function_name)
          and tgenabled in ('O', 'A') and not tgisinternal)
    )
    and (select count(*) = 2 from pg_class
      where oid in (to_regclass('public.meetup_payments'), to_regclass('public.meetup_payment_attempts'))
        and relrowsecurity);
$$;
revoke all on function public.payment_checkout_ready() from public, anon, authenticated;
grant execute on function public.payment_checkout_ready() to service_role;
