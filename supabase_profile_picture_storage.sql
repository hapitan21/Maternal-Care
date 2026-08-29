-- Maternal Care profile pictures
-- Doctor, Staff, and Patient
-- Run manually in Supabase SQL Editor.

begin;

-- =========================================================
-- 1. Profile avatar column
-- =========================================================

alter table public.profiles
  add column if not exists avatar_url text;


-- =========================================================
-- 2. Safe RPC: authenticated user may update only own avatar
-- =========================================================

create or replace function public.set_current_user_avatar_url(
  p_avatar_url text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_avatar_url text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  v_avatar_url := nullif(pg_catalog.btrim(p_avatar_url), '');

  update public.profiles
  set avatar_url = v_avatar_url
  where id = auth.uid();

  if not found then
    raise exception 'The authenticated profile was not found.'
      using errcode = 'P0002';
  end if;

  return v_avatar_url;
end;
$function$;

revoke all
on function public.set_current_user_avatar_url(text)
from public, anon, authenticated;

grant execute
on function public.set_current_user_avatar_url(text)
to authenticated;


-- =========================================================
-- 3. Storage bucket
-- =========================================================

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'profile-pictures',
  'profile-pictures',
  true,
  5242880,
  array[
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;


-- =========================================================
-- 4. Remove previous versions of these policies
-- =========================================================

drop policy if exists
  "Users can read their own profile picture object"
on storage.objects;

drop policy if exists
  "Users can upload their own profile picture"
on storage.objects;

drop policy if exists
  "Users can update their own profile picture"
on storage.objects;

drop policy if exists
  "Users can delete their own profile picture"
on storage.objects;


-- =========================================================
-- 5. Storage policies
--
-- Exact object path:
-- <auth.uid()>/avatar
-- =========================================================

create policy
  "Users can read their own profile picture object"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'profile-pictures'
  and name = (select auth.uid()::text) || '/avatar'
);


create policy
  "Users can upload their own profile picture"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'profile-pictures'
  and name = (select auth.uid()::text) || '/avatar'
);


create policy
  "Users can update their own profile picture"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'profile-pictures'
  and name = (select auth.uid()::text) || '/avatar'
)
with check (
  bucket_id = 'profile-pictures'
  and name = (select auth.uid()::text) || '/avatar'
);


create policy
  "Users can delete their own profile picture"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'profile-pictures'
  and name = (select auth.uid()::text) || '/avatar'
);


-- Refresh PostgREST after adding avatar_url / RPC
notify pgrst, 'reload schema';

commit;