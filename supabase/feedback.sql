-- Maison Moi feedback: what signed-in people send from feedback.html. Run once in the Supabase SQL Editor.
-- People can add feedback but never read it back (no select policy). Read it in Table Editor > feedback.
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  email text,
  category text not null default 'idea' check (category in ('idea', 'bug', 'love', 'other')),
  message text not null check (char_length(btrim(message)) between 1 and 4000),
  page text check (char_length(page) <= 300),
  user_agent text check (char_length(user_agent) <= 500)
);
alter table public.feedback enable row level security;

drop policy if exists "Send your own feedback" on public.feedback;
create policy "Send your own feedback" on public.feedback for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Inserts only: nothing in the app can read, change or delete feedback.
revoke all on public.feedback from anon, authenticated;
grant insert (email, category, message, page, user_agent) on public.feedback to authenticated;
