-- Optional testing-only helper.
-- Use this only if you intentionally want to mark the staff test email as
-- confirmed without clicking the email confirmation link.
--
-- Normal flow: use the app's "Resend verification email" button and open the
-- email from jamesfreeyian@gmail.com.

begin;

update auth.users
set
  email = 'jamesfreeyian@gmail.com',
  email_confirmed_at = coalesce(email_confirmed_at, now()),
  confirmed_at = coalesce(confirmed_at, now()),
  updated_at = now()
where id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid;

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

update public.profiles
set email = 'jamesfreeyian@gmail.com'
where id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid;

select
  u.id,
  u.email as auth_email,
  u.email_confirmed_at,
  p.email as profile_email,
  p.role
from auth.users u
left join public.profiles p on p.id = u.id
where u.id = 'f60d3bee-52e8-4c44-b3f4-26f6fc60436b'::uuid;

commit;
