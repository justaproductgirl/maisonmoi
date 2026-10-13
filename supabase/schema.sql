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

-- Photos: private bucket, each user gets a folder named after their user id
insert into storage.buckets (id, name, public) values ('closet-photos', 'closet-photos', false)
  on conflict (id) do nothing;
drop policy if exists "own photos" on storage.objects;
create policy "own photos" on storage.objects for all
  using (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'closet-photos' and (storage.foldername(name))[1] = auth.uid()::text);
