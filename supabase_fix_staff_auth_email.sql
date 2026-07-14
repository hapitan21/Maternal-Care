-- Run this in Supabase SQL Editor only if the staff email was changed in
-- public.profiles but Supabase Auth still has the old login email.
--
-- This keeps the same Supabase user ID, role, profile, appointments, and records.
-- It does not change the password. If the password is also unknown, use
-- Authentication > Users > Send password recovery after running this.

begin;

-- 1) Confirm the staff profile row.
select id, full_name, email, role
from public.profiles
where lower(role) = 'staff'
  and (
    email ilike 'staff@gmail.com'
    or email ilike 'jamesfreeyian@gmail.com'
    or email ilike 'jamesfreeyiann@gmail.com'
    or email ilike 'jamesfreeyiannn@gmail.com'
    or id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid
  );

-- 2) Update the public profile email to the exact new email.
update public.profiles
set email = 'jamesfreeyian@gmail.com'
where id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid;

-- 3) Update the Supabase Auth login email for the same user ID.
update auth.users
set
  email = 'jamesfreeyian@gmail.com',
  updated_at = now(),
  email_change = '',
  email_change_token_current = '',
  email_change_token_new = '',
  email_change_confirm_status = 0
where id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid;

-- 4) Keep the email identity row synchronized.
update auth.identities
set
  identity_data =
    jsonb_set(
      jsonb_set(
        identity_data,
        '{email}',
        to_jsonb('jamesfreeyian@gmail.com'::text),
        true
      ),
      '{email_verified}',
      'true'::jsonb,
      true
    ),
  updated_at = now()
where user_id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid
  and provider = 'email';

-- 5) Check the final Auth and profile values before commit.
select
  u.id,
  u.email as auth_login_email,
  p.email as profile_email,
  p.role
from auth.users u
left join public.profiles p on p.id = u.id
where u.id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid;

commit;
