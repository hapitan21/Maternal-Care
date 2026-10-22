# Staff and Doctor loading review — October 21, 2026

## Findings and implementation

Patient startup was implemented locally in `Patient_PWA.jsx` as `PatientLoadingScreen`, using `MaternalCareLogo` with the status variant. Its effective logo width is 170px from `maternal-care-logo.css`. `patient-PWA.css` supplied the centered viewport, #f9fafb background, #ff4b8b text, weight 800, and 12px spacing. The startup card is static: it has no spinning logo or progress animation. Patient page entrance uses `pwaPageIn` (220ms ease, opacity and an 8px upward movement).

Without an account cache, Patient displays startup loading while verifying its authenticated user, role, linked account status, and profile. A cached account remains visible during validation. An active flag discards results after unmount; successful validation sets access to active. Access failures render the existing access-state screen, including retry for query failures. Page chunks already share `WorkspaceSectionFallback`: a pink 720ms spinner with Poppins text, polite status announcements, and reduced-motion support in `index.css`. Patient data fetching uses local flags/caches and section states; it does not put a global overlay over every request. App-level lazy-route loading also already exists in `App.jsx`.

The inconsistent Staff/Doctor appearance came from Staff authorization depending on Admin text-only styling, Doctor authorization using the app spinner, and several data/form views having separate text-only or icon loaders. Missing rejection handling in Staff dashboard/appointments, clinical forms, and some Doctor record reads could leave loading flags set or produce unhandled promise rejections.

The Patient startup card is now extracted into `WorkspaceLoadingScreen` and scoped `workspace-loading.css`, used by Patient startup and Staff/Doctor initial route/auth loading. The existing Patient font import moves with these styles; no duplicate startup CSS or loading library is added. Patient access checks, caches, page transitions, section spinner design, and data-fetching logic are unchanged.

Staff directory, appointment table, dashboard sessions, profile, settings, and both assessment types now reuse the existing Patient section indicator where a loading state is appropriate. Table loaders use a compact variant. Doctor profile, settings, record sections, and Initial/Follow-Up Visit forms reuse the same indicator. Existing Doctor dashboard, directory, appointment, and reminder skeletons remain in place. Initial lazy loading of every Staff/Doctor section already uses the shared section fallback. Registration continues using its existing workflow and local slot-loading states.

Clinical reads now catch rejected requests and clear loading in a current-request-only `finally`. `settleQuery` routes rejected transport promises through existing Supabase `{ data, error }` handling for the affected list/record reads. Staff dashboard and appointment failures have local retry controls. Failed dashboard requests no longer leave “Loading today's schedule” visible after completion. Staff profile/appointment reads and Doctor record reads reject stale results; changing the selected Doctor patient also resets obsolete loading flags. Optional medication-adherence reads discard outdated results.

No artificial waits, new data requests, background-operation overlays, dependency changes, or automatic reloads were added. Existing authentication hooks, query projections, role restrictions, mutation payloads, save handlers, registration, QR/account activation, appointment creation, realtime subscriptions, and clinical normalization/validation remain intact. No database, Android, FCM, APK, or SMS files were changed. Existing unrelated working-tree changes were preserved. Nothing was committed, pushed, or deployed.

## Exact files changed for this task

| File | Change |
| --- | --- |
| `src/App.jsx` | Shared Staff/Doctor startup screen; authorization gates retained |
| `src/components/common/WorkspaceLoadingScreen.jsx` | Extracted Patient startup card |
| `src/components/common/WorkspaceSectionFallback.jsx` | Optional compact variant; existing default unchanged |
| `src/styles/workspace-loading.css` | Extracted, scoped startup styling and existing font import |
| `src/index.css` | Compact section-loader spacing |
| `src/styles/patient-PWA.css` | Remove extracted startup rules and font import |
| `src/styles/maternal-care-logo.css` | Remove obsolete startup selector; access-state selector retained |
| `src/pages/patient/Patient_PWA.jsx` | Consume extracted startup component |
| `src/lib/settleQuery.js` | Normalize rejected read promises into existing error-result handling |
| `src/pages/staff/StaffDashboard.jsx` | Rejection cleanup, retry, session loader, completed-error wording |
| `src/pages/staff/Staff_Appointments.jsx` | Read rejection handling, stale-result guard, retry, table loader |
| `src/pages/staff/Staff_Patients.jsx` | Directory loading row and busy state |
| `src/pages/staff/Staff_ViewProfile.jsx` | Shared loader and stale-result guard |
| `src/pages/staff/Staff_Settings.jsx` | Local shared loading status; forms remain mounted |
| `src/pages/doctor/Doctor_Appointments.jsx` | Handle rejected patient suggestion reads |
| `src/pages/doctor/Doctor_Medical_Records.jsx` | Shared section indicators, read rejection handling and invalidation |
| `src/pages/doctor/Doctor_ViewProfile.jsx` | Shared profile loader |
| `src/pages/doctor/Doctor_Settings.jsx` | Local shared loading status; drafts remain mounted |
| `src/pages/appointments/StaffPreConsultationForm.jsx` | Shared loader and guarded rejection/finally cleanup |
| `src/pages/appointments/AppointmentVisitForm.jsx` | Shared loader and guarded rejection/finally cleanup |
| `scripts/verify-workspace-loading.mjs` | Offline loading lifecycle and preservation checks |
| `docs/staff-doctor-loading-review.md` | This report |

## Verification

- `node scripts/verify-workspace-loading.mjs`: **91 checks passed**. Executes actual source callbacks with controlled pending, failed, empty, repeated, and stale responses. Covers clinical rejection stages, preservation of existing values after load failure, Staff retry/coalescing, Doctor record errors, patient-switch resets, profile invalidation, Patient design constants, and unchanged authentication/workflow source contracts. No backend access.
- `node scripts/verify-doctor-visit-record-mapping.mjs`: **399 checks passed**, using actual form/load/save/JSX with a mocked backend.
- `node scripts/verify-staff-registration-validation.mjs`: **967 assertions passed**, using actual handlers/SSR and CSS-source checks with synthetic transports. This is not a live registration or browser-layout test.
- `node scripts/verify-doctor-route-authorization.mjs`: **passed**, including the persistent Doctor route branch.
- Scoped ESLint across all 16 changed JS/JSX application files: **passed, no warnings**.
- `git diff --check`: **passed** with the repository's normal line-ending configuration.
- `npm.cmd run build` (`npm run build` through the Windows command shim): **passed**. Existing bundle-size warning remains.

Two additional older scripts fail their source-snapshot assertions: `verify-staff-followup-baseline.mjs` and `verify-staff-intake-numeric-validation.mjs`. Both strip the current save-feedback navigation state before comparing it with HEAD, although HEAD already contains that state. Each failure was reproduced using the original HEAD form source in a temporary offline test copy, which was removed afterward. The numeric script's ten behavior groups pass before its stale snapshot assertion. The loading suite separately verifies that `saveForm`, `normalizeLoadedForm`, and `validateStaffIntake` exactly match HEAD. These older tests were not edited, and their failures are not counted as passes.

## Authenticated browser checks still required

The Browser skill was used to attempt a connection, but no browser was available. No authenticated/live viewport checks are claimed. Before the defense, verify these against a safe test environment with Staff, Doctor, and Patient accounts:

1. Cold direct entry, restored sessions, tab focus/token refresh, and navigation between all main pages. Confirm background auth checks do not unmount clinical forms.
2. Slow and failed requests, empty datasets, local retry controls, and rapid navigation between patients/appointments. Confirm no old results replace the current selection.
3. Staff registration's three steps, automatic initial appointment, QR/Create Account activation, both Staff assessments, and both Doctor visit types. Enter draft values, switch sections within the forms, and confirm validation/save/navigation still behave as before.
4. Doctor Medical Records/Doctor's Order, reminder realtime updates, and appointment actions. Verify permissions with each role.
5. Desktop (for example 1440×900) and mobile (390×844 and 360×800) layouts. Compare startup typography/logo/colors with Patient, check section-loader fit and reduced-motion mode, and confirm no overlapping indicators or horizontal overflow.

The offline tests do not establish actual Supabase session restoration, RLS behavior, network/browser timing, or pixel-level viewport parity. Reads still rely on the existing transport settling; no new global network timeout or authentication policy was introduced.
