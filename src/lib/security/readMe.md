# Application Security Files

This folder contains security guidance and a local static verification script. The checks are designed to be additive: they do not execute in the browser and do not alter appointment, clinical, reminder, authentication, or PWA flows.

## Files

- [System security plan](./systemSecurityPlan.md) records scope, boundaries, and priorities.
- [Role access matrix](./roleAccessMatrix.md) describes intended access for each role and negative checks to run.
- [XSS review](./xssReview.md) records safe rendering rules and the current limited source scan.
- [Security test plan](./securityTestPlan.md) provides safe local/preview checks.
- [Client security verifier](./verifyClientSecurity.mjs) checks for common unsafe DOM/script sinks, privileged `VITE_` names, and deployed source maps.

Run the verifier from the repository root with `npm run security:check`. It is a static check, not a penetration test and not proof of secure Supabase policies.

## Safe-use rules

- Never store credentials, tokens, patient information, production exports, or incident evidence in this folder.
- Treat browser code and `VITE_` environment variables as public.
- Use synthetic accounts and records for tests.
- Do not modify production RLS, run production SQL, or deploy without a reviewed change plan.
