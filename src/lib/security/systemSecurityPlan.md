# System Security Plan

## Purpose and scope

This working plan covers the React/Vite application deployed on Vercel and its Supabase authentication and data access. It includes the Admin, Doctor, Staff, and Patient experiences and sensitive maternal-health information.

This document is not a penetration-test report, compliance certification, or guarantee that the system is secure. Verify every control in its deployed environment.

## Priorities

1. Enforce access at the data boundary: review Supabase table grants and RLS policies for least privilege, and test allowed and denied operations for all four roles. Client-side route guards and hidden controls are not authorization boundaries.
2. Protect credentials: browser code and all `VITE_` variables are public. Use only a publishable/legacy anon Supabase key in browser code, paired with correct RLS. Keep secret/service-role keys in trusted server or Edge Function environments. Rotate privileged keys if they were ever committed or shipped.
3. Reduce injection risk: render untrusted values as text, validate URL schemes and structured inputs, and sanitize HTML only if rendering user-supplied HTML is a real feature requirement.
4. Add browser defenses: configure security headers through Vercel. Start CSP in report-only mode, test on a preview, review browser console violations and required origins, then plan enforcement as a separate reviewed change.
5. Harden operations: enable MFA for privileged accounts where supported, review authentication abuse protections, restrict Vercel project access and preview deployments, and maintain dependencies and backups.

## Trust boundaries

- The browser, JavaScript bundle, local storage, and user input are untrusted and can be inspected or modified by the user.
- Supabase Auth identifies the signed-in user. Database grants and RLS must enforce the user's permitted rows and operations.
- Vercel hosts the frontend and may host trusted server functions. Anything exposed to browser code is public.
- Patient and clinical information is sensitive. Use synthetic data outside production.

## Initial repository observations

Read-only source/configuration scan dated 2026-10-22; this is not a complete audit:

- `vercel.json` originally contained only filesystem handling and the SPA fallback route. A report-only CSP and non-blocking baseline headers have now been added; verify their delivery on a Vercel preview before deciding on enforcement.
- `vite.config.js` does not enable production source maps. Vite documents `build.sourcemap` as false by default; verify the built and deployed artifacts rather than relying only on defaults.
- The client references `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_WEB_PUSH_PUBLIC_KEY`. These names do not prove whether a privileged secret is exposed elsewhere; review actual values privately and never paste them into documentation.
- A simple search of `src/` found no direct `dangerouslySetInnerHTML`, `innerHTML =`, `eval()`, or `new Function()` usage. This does not cover dependencies, every DOM sink, or runtime behavior.
- Supabase policies/grants, production response headers, Vercel project settings, and deployed artifacts have not been audited by these files.

## Change safety

Keep security checks additive and preserve appointment, clinical, reminder, role, and PWA workflows. Test frontend configuration on a Vercel preview and database authorization with local/staging fixtures. The configured CSP is **report-only** and will not block resources; do not switch it to enforcing mode until preview testing confirms compatibility.
