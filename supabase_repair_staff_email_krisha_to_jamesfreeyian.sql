-- DEVELOPMENT / TESTING ONLY
-- Repairs the staff account email to match the current email-change test:
--   current/old email: krishagelogogeacaniga@gmail.com
--   new email:         jamesfreeyian@gmail.com
--
-- Use this only if Supabase Auth and public.profiles are already out of sync.
-- This does not change the password.

begin;

-- Find the staff Auth user by either email or by the staff profile role.
with target_user as (
  select u.id
  from auth.users u
  where lower(trim(u.email)) in (
    'krishagelogogeacaniga@gmail.com',
    'jamesfreeyian@gmail.com'
  )

  union

  select p.id
  from public.profiles p
  where lower(trim(p.role)) = 'staff'
    and lower(trim(p.email)) in (
      'krishagelogogeacaniga@gmail.com',
      'jamesfreeyian@gmail.com'
    )
  limit 1
)
update auth.users u
set
  email = 'jamesfreeyian@gmail.com',
  email_confirmed_at = coalesce(u.email_confirmed_at, now()),
  updated_at = now(),
  email_change = '',
  email_change_token_current = '',
  email_change_token_new = '',
  email_change_confirm_status = 0
where u.id = (select id from target_user);

with target_user as (
  select u.id
  from auth.users u
  where lower(trim(u.email)) = 'jamesfreeyian@gmail.com'
  limit 1
)
update auth.identities i
set
  identity_data =
    coalesce(i.identity_data, '{}'::jsonb)
    || jsonb_build_object(
      'sub', i.user_id::text,
      'email', 'jamesfreeyian@gmail.com',
      'email_verified', true
    ),
  updated_at = now()
where i.user_id = (select id from target_user)
  and i.provider = 'email';

with target_user as (
  select u.id
  from auth.users u
  where lower(trim(u.email)) = 'jamesfreeyian@gmail.com'
  limit 1
)
update public.profiles p
set email = 'jamesfreeyian@gmail.com'
where p.id = (select id from target_user);

with target_user as (
  select u.id
  from auth.users u
  where lower(trim(u.email)) = 'jamesfreeyian@gmail.com'
  limit 1
)
update public.staff_professional_information spi
set email_address = 'jamesfreeyian@gmail.com',
    updated_at = now()
where spi.auth_user_id = (select id from target_user);

select
  u.id,
  u.email as auth_email,
  u.email_confirmed_at,
  p.email as profile_email,
  p.role,
  spi.email_address as staff_professional_email
from auth.users u
left join public.profiles p on p.id = u.id
left join public.staff_professional_information spi on spi.auth_user_id = u.id
where lower(trim(u.email)) = 'jamesfreeyian@gmail.com';

commit;
