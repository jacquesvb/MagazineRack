-- Run this in the Supabase SQL Editor. All catalog tables are protected by RLS.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chosen_username text;
begin
  chosen_username := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
    'reader-' || left(new.id::text, 8)
  );
  insert into public.profiles (id, username)
  values (new.id, chosen_username)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  thumbnail_data text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table if not exists public.publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  archive_identifier text not null,
  pdf_filename text not null,
  source_url text not null,
  title text not null,
  date text not null default '',
  publisher text not null default '',
  creator text not null default '',
  description text not null default '',
  language text not null default '',
  rights text not null default '',
  subjects jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  overrides_json jsonb not null default '{}'::jsonb,
  thumbnail_data text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, archive_identifier, pdf_filename)
);

create table if not exists public.collection_publications (
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null,
  publication_id uuid not null,
  position integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (user_id, collection_id, publication_id),
  foreign key (user_id, collection_id) references public.collections(user_id, id) on delete cascade,
  foreign key (user_id, publication_id) references public.publications(user_id, id) on delete cascade
);

alter table public.profiles enable row level security;
alter table public.collections enable row level security;
alter table public.publications enable row level security;
alter table public.collection_publications enable row level security;

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Users can update their profile" on public.profiles;
create policy "Users can update their profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "Users manage their collections" on public.collections;
create policy "Users manage their collections" on public.collections for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users manage their publications" on public.publications;
create policy "Users manage their publications" on public.publications for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users manage their collection links" on public.collection_publications;
create policy "Users manage their collection links" on public.collection_publications for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, update, delete on public.publications to authenticated;
grant select, insert, update, delete on public.collection_publications to authenticated;
