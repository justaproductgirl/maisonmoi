-- Maison Moi database. Paste into Supabase: SQL Editor > New query > Run. Safe to run more than once.
-- Every row belongs to one signed-in user, and row level security makes sure people only ever see their own.

-- Profile: name, zip, goals, theme and other settings
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users on delete cascade default auth.uid(),
  name       text,
  zip        text,
  theme      text default 'lbd',
  settings   jsonb not null default '{}',
  rev        text,               -- changes on every save, so a device can tell whether another device saved since
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists rev text;

-- Closet pieces: one row each. The full item (brand, size, tags, wears...) lives in data, so the app can add fields freely.
create table if not exists public.items (
  user_id    uuid not null references auth.users on delete cascade default auth.uid(),
  id         text not null,
  data       jsonb not null,
  image_path text,               -- photo in the closet-photos bucket: <user_id>/<file>
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Everything else the app remembers: wear history, outfits, boards, laundry, shop picks
create table if not exists public.closet_state (
  user_id    uuid primary key references auth.users on delete cascade default auth.uid(),
  state      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.profiles     enable row level security;
alter table public.items        enable row level security;
alter table public.closet_state enable row level security;

drop policy if exists "own profile" on public.profiles;
drop policy if exists "own items"   on public.items;
drop policy if exists "own state"   on public.closet_state;
create policy "own profile" on public.profiles     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own items"   on public.items        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own state"   on public.closet_state for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Photos: private bucket, each user gets a folder named after their user id.
-- Images only, 5 MB each (the app shrinks uploads to about 100 KB), and a cap on how many photos one account can keep.
insert into storage.buckets (id, name, public) values ('closet-photos', 'closet-photos', false)
  on conflict (id) do nothing;
update storage.buckets set file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  where id = 'closet-photos';

-- Room for another photo? Free accounts keep up to 200, Plus up to 5,000. Lives outside the public API schema.
create schema if not exists private;
create or replace function private.photo_room() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from storage.objects
          where bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text)
       < case when exists (select 1 from public.subscriptions where user_id = auth.uid() and status in ('trialing', 'active', 'comped'))
              then 5000 else 200 end
$$;
revoke all on function private.photo_room() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.photo_room() to authenticated;

drop policy if exists "own photos" on storage.objects;
drop policy if exists "own photos read" on storage.objects;
drop policy if exists "own photos add" on storage.objects;
drop policy if exists "own photos change" on storage.objects;
drop policy if exists "own photos remove" on storage.objects;
create policy "own photos read" on storage.objects for select to authenticated
  using (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos add" on storage.objects for insert to authenticated
  with check (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text and private.photo_room());
create policy "own photos change" on storage.objects for update to authenticated
  using (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos remove" on storage.objects for delete to authenticated
  using (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text);
