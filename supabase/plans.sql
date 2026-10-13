-- Maison Moi Plus: who is on which plan. Run once in the Supabase SQL Editor.
-- Only the Stripe webhook (service role) writes here; people can read their own row.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users on delete cascade,
  status text not null default 'free',            -- free, trialing, active, past_due, canceled, comped
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  price_id text,
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'subscriptions' and policyname = 'read own subscription') then
    create policy "read own subscription" on public.subscriptions for select using (auth.uid() = user_id);
  end if;
end $$;

-- Free closets hold 15 pieces. Enforced here too, so it can't be skipped by editing the app in the browser.
create or replace function public.enforce_item_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from items where user_id = new.user_id and id = new.id) then return new; end if;  -- edits are always fine
  if exists (select 1 from subscriptions where user_id = new.user_id and status in ('trialing', 'active', 'comped')) then return new; end if;
  if (select count(*) from items where user_id = new.user_id and coalesce((data->>'demo')::boolean, false) = false) >= 15 then
    raise exception 'Your Free closet holds 15 pieces. Upgrade to Maison Moi Plus to add more.';
  end if;
  return new;
end $$;
create or replace trigger items_limit before insert on public.items
  for each row when (coalesce((new.data->>'demo')::boolean, false) = false) execute function public.enforce_item_limit();

-- Founder's pass for the owner's account.
insert into public.subscriptions (user_id, status)
select id, 'comped' from auth.users where email = 'jackievwallace@gmail.com'
on conflict (user_id) do update set status = 'comped', updated_at = now();
