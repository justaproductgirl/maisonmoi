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
-- Sample pieces (data.demo) don't count, but an account holds at most 20 of them (the size of the sample closet), and
-- turning a sample into a real piece counts like adding one. The lock makes two devices adding at once wait their turn.
create or replace function public.enforce_item_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_demo boolean := coalesce((new.data->>'demo')::boolean, false);
begin
  if tg_op = 'INSERT' and exists (select 1 from items where user_id = new.user_id and id = new.id) then return new; end if; -- an upsert of a saved piece; the UPDATE pass checks it
  if tg_op = 'UPDATE' and is_demo = coalesce((old.data->>'demo')::boolean, false) then return new; end if;            -- ordinary edits are always fine
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if is_demo then
    if (select count(*) from items where user_id = new.user_id and id <> new.id and coalesce((data->>'demo')::boolean, false)) >= 20 then
      raise exception 'The sample closet holds 20 pieces.';
    end if;
    return new;
  end if;
  if exists (select 1 from subscriptions where user_id = new.user_id and status in ('trialing', 'active', 'comped')) then return new; end if;
  if (select count(*) from items where user_id = new.user_id and id <> new.id and not coalesce((data->>'demo')::boolean, false)) >= 15 then
    raise exception 'Your Free closet holds 15 pieces. Upgrade to Maison Moi Plus to add more.';
  end if;
  return new;
end $$;
drop trigger if exists items_limit on public.items;
create trigger items_limit before insert or update on public.items
  for each row execute function public.enforce_item_limit();
revoke execute on function public.enforce_item_limit() from public, anon, authenticated; -- only the trigger runs it

-- Founder's pass for the owner's account.
insert into public.subscriptions (user_id, status)
select id, 'comped' from auth.users where email = 'jackievwallace@gmail.com'
on conflict (user_id) do update set status = 'comped', updated_at = now();
