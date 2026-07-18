-- Home Design App — cloud projects schema.
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query)
-- for a fresh project. Safe to re-run: every statement is idempotent.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Untitled',
  data jsonb not null default '{}'::jsonb,
  -- when true, the project is readable by anyone with its id (view-only
  -- share link) — the id itself is an unguessable random uuid, same trust
  -- model as "anyone with the link" in Google Docs/Figma etc.
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- for projects created before this column existed
alter table public.projects add column if not exists is_public boolean not null default false;

create index if not exists projects_user_id_idx on public.projects (user_id);

alter table public.projects enable row level security;

-- Each user can only ever see/change their own projects — this is the only
-- thing standing between "everyone has their own login" and "everyone can
-- read everyone else's floor plans," so it's not optional.
drop policy if exists "Users select own projects" on public.projects;
create policy "Users select own projects" on public.projects for select using (auth.uid() = user_id);

-- Additive to the policy above (Postgres OR's multiple permissive SELECT
-- policies together): anyone — including a signed-out/anonymous visitor —
-- can read a project that its owner has explicitly marked public. This is
-- the only policy that doesn't check auth.uid(), and it's scoped to SELECT
-- only, so a public share link can never be used to modify or delete
-- someone else's project.
drop policy if exists "Anyone can select public projects" on public.projects;
create policy "Anyone can select public projects" on public.projects for select using (is_public = true);

drop policy if exists "Users insert own projects" on public.projects;
create policy "Users insert own projects" on public.projects for insert with check (auth.uid() = user_id);

drop policy if exists "Users update own projects" on public.projects;
create policy "Users update own projects" on public.projects for update using (auth.uid() = user_id);

drop policy if exists "Users delete own projects" on public.projects;
create policy "Users delete own projects" on public.projects for delete using (auth.uid() = user_id);
