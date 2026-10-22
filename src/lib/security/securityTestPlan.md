# Security Test Plan

Run these checks locally or on a Vercel preview/staging environment with synthetic data. Production database changes, production SQL, and deployment are outside this plan.

## Before each security release

1. Run targeted lint, relevant tests, `npm run build`, and `npm run security:check`.
2. Verify no secret/service-role key, access token, or private key appears in source, newly added Git changes, browser-exposed environment variables, or built assets. Public publishable/anon keys are expected in client code and must be protected by RLS.
3. Execute the role access checks in `roleAccessMatrix.md` against synthetic fixtures. Include denied reads, inserts, updates, and deletes where applicable.
4. Review changed input/output paths using `xssReview.md`; verify harmless HTML-like strings render as text.
5. On a Vercel preview, inspect response headers and browser console/network output. CSP is currently report-only: violations are observations and do not block requests. Confirm required Supabase, font, image, and application requests before proposing enforcement.
6. Check sign-in/out, password recovery, session expiry, appointment creation/rescheduling, patient and clinical forms, reminders, and mobile/PWA behavior after security configuration changes.
7. Run `git diff --check` and review the exact diff for unrelated changes or secrets.

## Supabase authorization verification

- Use local Supabase or an approved staging project with synthetic accounts for every role.
- Test with each role's authenticated session, not only the SQL Editor or service role. A privileged SQL Editor session cannot prove what an end-user JWT can access.
- Verify table grants and RLS policies together; test both allowed and denied operations.
- Do not run `supabase db push`, production SQL, or migrations without explicit approval and a reviewed change plan.

## Result record

Record change identifier, environment, commands/checks, pass/fail result, and unresolved items. Keep credentials and patient data out of the record.
