-- Maison Moi admin: one read-only overview for the owner. Run once in the Supabase SQL Editor.
-- The admins table has row level security on and no policies, so nobody can read or change it through the app.
create table if not exists public.admins (user_id uuid primary key references auth.users on delete cascade);
alter table public.admins enable row level security;
insert into public.admins (user_id) select id from auth.users where email = 'jackievwallace@gmail.com' on conflict do nothing;

-- Everyone's totals plus a list of accounts. Only callable by someone in admins; it returns an error for anyone else.
create or replace function public.admin_overview() returns jsonb
language plpgsql security definer set search_path = public, auth, storage as $$
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'not allowed';
  end if;
  return jsonb_build_object(
    'accounts', (select count(*) from auth.users),
    'new_week', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active_week', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'plans', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
      select coalesce(s.status, 'free') as status, count(*) as n from auth.users u left join public.subscriptions s on s.user_id = u.id group by 1) x),
    'paying_prices', (select coalesce(jsonb_object_agg(coalesce(price_id, 'unknown'), n), '{}'::jsonb) from (
      select price_id, count(*) as n from public.subscriptions where status = 'active' group by 1) x),
    'pieces', (select count(*) from public.items),
    'photos', (select count(*) from storage.objects where bucket_id = 'closet-photos'),
    'people', (select coalesce(jsonb_agg(p), '[]'::jsonb) from (
      select jsonb_build_object('email', u.email, 'name', pr.name, 'joined', u.created_at, 'last', u.last_sign_in_at,
        'confirmed', u.email_confirmed_at is not null, 'plan', coalesce(s.status, 'free'), 'trial_end', s.trial_end,
        'pieces', (select count(*) from public.items i where i.user_id = u.id)) as p
      from auth.users u left join public.profiles pr on pr.user_id = u.id left join public.subscriptions s on s.user_id = u.id
      order by u.created_at desc limit 200) q));
end $$;
revoke execute on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
