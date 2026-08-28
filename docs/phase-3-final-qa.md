# Phase 3 Final QA and Presentation Readiness

Date: 2026-08-26

## Overall status

**Conditional presentation-ready.** The application passes lint, production build, route-authorization unit checks, local HTTP checks, Supabase connectivity, and PWA manifest validation. Source-level review confirms role checks are present for doctor, staff, patient, and admin workspaces. A final authenticated visual walkthrough is still required because no controllable browser session or test credentials were available during this QA run.

No production-like patient, appointment, medication, notification, or user records were created or modified.

## Fixes implemented

- Added an application-level missing-route screen instead of leaving unmatched public URLs blank.
- Kept Doctor sections code-split while preventing the full section-loading screen during in-app navigation by preloading the selected chunk and transitioning from the current content.
- Added a consistent keyboard focus fallback for links, buttons, and form controls.
- Added a global reduced-motion fallback while preserving readable loading text.
- Made the mobile Admin navigation drawer identify itself as a dialog, move focus into the drawer, trap Tab focus, close with Escape, and return focus to the menu trigger.
- Preserved accessible names for Staff navigation when its visible labels are hidden at mobile widths; added current-page state to Doctor and Staff navigation.
- Completed Doctor, Staff, and Patient account-menu semantics and restored trigger focus after Escape.
- Improved Patient notification panel relationships, busy/loading announcements, Escape focus return, and error announcements.
- Improved Doctor notification and dashboard error announcements.

## Checks passed

- `npm.cmd run lint` — passed with no ESLint findings.
- `npm run build` — passed; 2,155 modules transformed.
- `git diff --check` — passed; only existing line-ending conversion notices were reported.
- Doctor route-authorization assertions — 6/6 passed: signed out, active Doctor, inactive Doctor, Staff mismatch, Admin mismatch, and mismatched profile ID.
- Local Vite HTTP checks — `/`, a missing public route, `/doctor/dashboard`, and `/patient/dashboard` all returned the SPA entry successfully.
- Supabase auth health — HTTP 200 using the configured anonymous browser key.
- PWA manifest — valid JSON, required fields present, and all four declared icon assets exist.
- Static responsive review — primary shells have explicit desktop/tablet/mobile behavior; large tables are placed in horizontal scroll containers; mobile Patient content reserves space for the fixed bottom navigation; major dialog styles use constrained viewport height and internal scrolling.
- Static authorization review — Doctor, Staff, and Admin require an authenticated profile with the correct active role; Patient requires an authenticated Patient profile plus an active linked patient record.
- Static accessibility review — main auth forms use labels; major loading/error states expose status or alert semantics; core dialogs include accessible names, Escape handling, and focus containment; icon-only shell controls have accessible names.

## Remaining warnings and manual tests

### Required before the live presentation

- Visually inspect at approximately 1440, 1024, 768, and 390 CSS pixels using browser developer tools. Check headers, profile menus, fixed navigation, tables, dialogs, long names, and validation messages.
- Complete one keyboard-only pass: login, all role navigation, profile menus, Admin mobile drawer, notification panels, and at least one edit dialog.
- Check browser console and network panels while completing the authenticated workflows below. The in-app browser was unavailable during this run, so these could not be truthfully marked passed.
- Use safe demo accounts to confirm cross-role redirects for Doctor, Staff, Patient, and Admin, plus signed-out deep links and logout.
- Confirm Patient registration/account linking with a designated demo patient and a non-production control code.
- Confirm appointment create/filter/status-change, medical-record view/edit, reminder/notification delivery, Admin user navigation, and all Patient PWA sections.
- Confirm installability and service-worker update behavior from a production or HTTPS build. Local development does not fully represent install behavior.

### Non-blocking warnings

- The production build reports a chunk-size warning for export dependencies. The heavy `exceljs`, `jspdf`, `jspdf-autotable`, and related rendering code is emitted in separate chunks rather than the initial application shell. Keep exports lazy-loaded; do not suppress the warning for the demo.
- Google-hosted fonts depend on internet access, but the styles include local sans-serif fallbacks.
- There is no repository test script or existing automated browser test suite, so workflow coverage remains partly manual.
- Browser push depends on permission, service-worker support, and the configured Supabase/webhook path; in-app notification history should be the primary live demonstration.

## Authenticated manual test matrix

| Role/state | Minimum confirmation |
| --- | --- |
| Signed out | Deep-link to each protected workspace; confirm login/access screen and preserved safe destination where supported. |
| Doctor | Dashboard, patients, appointments, one medical record, reminders, profile/settings, logout. |
| Staff | Dashboard, patient directory/registration, appointment create/filter/status flow, profile/settings, logout. |
| Patient | Account linking, dashboard, profile, appointments, medical records, reminders/medication actions, notifications, settings, logout. |
| Admin | Dashboard, user management/details, appointment overview, reports, audit logs, settings/profile, logout. |
| Cross-role | Try each other role's protected URL and confirm the account is redirected or denied before protected data renders. |
| Missing route | Open a random public path and random path beneath each role; confirm a not-found screen or canonical safe redirect. |

## 5–7 minute capstone demonstration script

### 0:00–0:35 — Problem and system map

“Maternal Care connects clinic Staff, Doctors, Patients, and the System Admin in one role-protected workflow. I will follow one safe demo patient from registration and appointment handling through clinical follow-up and Patient self-service.”

Show the login screen and briefly name the four roles. Mention that each workspace rechecks the authenticated profile and account status.

### 0:35–1:45 — Staff intake and appointment workflow

Open a pre-authenticated Staff browser profile. Show the dashboard, responsive navigation, and patient directory. Use a clearly labelled demo patient to show registration/account-link information without exposing real data. Open Appointments, demonstrate filtering, then show the create or status-update flow. If changing data is not safe, stop at the confirmation step and explain the validated fields.

### 1:45–3:05 — Doctor clinical workflow

Switch to a pre-authenticated Doctor browser profile. Show today's dashboard totals and upcoming sessions, then open the same demo patient's medical record. Move through overview/prenatal or diagnostic content, explain that editing remains tied to the authenticated Doctor and Supabase policies, and show the medication adherence history without changing any reminder data.

### 3:05–4:20 — Patient PWA

Switch to the Patient profile at a 390 px viewport. Show the fixed bottom navigation, dashboard, appointments, medical records, reminders/medication schedule, notification panel, profile, and settings. Point out offline/connection status and installability. Demonstrate one safe acknowledgement only if it uses designated demo data.

### 4:20–5:20 — Admin oversight

Switch to Admin. Show dashboard metrics, User Management navigation and account status controls without confirming a destructive change, Appointment Overview, reports, and audit logs. Emphasize that Admin pages reject non-Admin accounts before rendering protected content.

### 5:20–6:10 — Quality and reliability proof

Show the mobile Admin drawer with keyboard focus, a scrollable table at tablet width, an accessible dialog, and the missing-route page. State the verified checks: clean ESLint, successful production build, Supabase health 200, valid PWA manifest, and focused authorization cases passing 6/6.

### 6:10–6:40 — Close

“The capstone is ready for a controlled presentation after the final authenticated browser walkthrough. The remaining checks require real role sessions, not code changes, and the demo uses isolated test data to protect clinic records.”

## Presentation backup plan

- **Internet failure:** keep the production build and a short screen recording or screenshots available locally. Use the local app shell to explain navigation and responsive behavior; avoid claiming live data changes.
- **Supabase failure:** pre-record the full cross-role workflow and export a small, de-identified demo report. Keep read-only screenshots for each role and show the successful health/build log captured before the presentation.
- **Notification/push failure:** demonstrate in-app notification history and reminder records first. Explain that OS push additionally requires browser permission, service-worker support, and webhook delivery.
- **PWA install prompt missing:** demonstrate the 390 px installed-style layout and validated manifest/icons, then show the browser's manual “Install app” or “Add to Home Screen” location in a prepared screenshot.
- **Credential/session failure:** prepare separate browser profiles for Staff, Doctor, Patient, and Admin, verify them shortly before the demo, and keep a read-only recording as the immediate fallback.
- **Unsafe or missing demo data:** do not improvise with real records. Use the prepared de-identified patient and stop mutations before final confirmation while narrating the validation and permission checks.
