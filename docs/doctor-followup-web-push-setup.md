# Doctor Follow-up Web Push Setup

Phase 5B.5 adds browser and operating-system push delivery for the four
medication follow-up escalation notification types already created in
`public.doctor_notifications`. The Phase 5B.4 processor and in-app bell remain
independent of this delivery layer.

Nothing in this guide is run automatically. Review and install each database,
function, secret, and webhook change manually in the correct Supabase project.

## Existing Pattern Reused

- VAPID variables: `WEB_PUSH_VAPID_PUBLIC_KEY`,
  `WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT`
- Browser variable: `VITE_WEB_PUSH_PUBLIC_KEY`
- Webhook authentication: `x-webhook-secret` matched against
  `WEB_PUSH_WEBHOOK_SECRET`
- Server credentials: hosted `SUPABASE_URL` and a Supabase secret/service-role
  key, never a Vite variable
- One existing `/sw.js` registration and its current `/patient/` cache scope
- Shared Web Push encryption/signing code in
  `supabase/functions/_shared/webPushDelivery.ts`

The Doctor flow uses the same VAPID key pair. Do not generate another pair or
put private keys, the webhook secret, or service-role credentials in React.

## Security and Privacy

`public.doctor_push_subscriptions` is separate from the Patient subscription
table. Doctors can read only their own endpoints; direct browser writes are
revoked and ownership-verifying RPCs perform enable and disable operations.

`public.doctor_notification_push_deliveries` is a separate server-only ledger.
No browser RLS policy exists and no browser role receives table or claim-RPC
access. One `(doctor_notification_id, doctor_push_subscription_id)` pair can
have only one successful delivery.

The Edge Function accepts only an INSERT webhook envelope and notification ID.
It refetches the authoritative row, verifies the supported type, exact Doctor
route, follow-up identifier, and active assigned Doctor, then loads that
Doctor's active subscriptions. Webhook title, message, Doctor ID, and target
path fields are not trusted.

Lock-screen content is limited to one of these titles:

- `Medication Follow-up Due Today`
- `Medication Follow-up Overdue`
- `High-Priority Follow-up Alert`
- `Critical Follow-up Alert`

Every push uses this body:

> A medication follow-up assigned to you requires attention. Open Maternal
> Care to review it securely.

The payload contains only the notification ID, validated Doctor target path,
escalation level, audience, and stable tag. It contains no Patient, medication,
adherence, contact, or clinical details.

## 1. Review and Install SQL

Review `supabase_doctor_followup_web_push.sql`, run its commented preflight
queries, and then apply it manually. It creates:

- `public.doctor_push_subscriptions`
- `public.doctor_notification_push_deliveries`
- `public.upsert_my_doctor_push_subscription(text,text,text,bigint,text,text)`
- `public.deactivate_my_doctor_push_subscription(text)`
- `public.claim_doctor_notification_push_delivery(uuid,uuid,integer)`

Run the commented verification queries after installation. Do not modify the
existing Patient subscription or delivery tables.

## 2. Review and Deploy the Edge Function

Review:

```text
supabase/functions/_shared/webPushDelivery.ts
supabase/functions/send-doctor-followup-web-push/index.ts
supabase/functions/send-doctor-followup-web-push/deno.json
```

The Doctor function uses the same four Web Push secrets already configured for
the Patient function. Confirm those hosted secrets exist without printing their
values. Then deploy manually:

```powershell
supabase functions deploy send-doctor-followup-web-push --no-verify-jwt
```

JWT verification is disabled because the caller is a Database Webhook. The
shared `x-webhook-secret` check remains mandatory.

## 3. Create the Database Webhook Manually

In Supabase Dashboard, open **Database > Webhooks** and create:

| Setting | Value |
| --- | --- |
| Name | `send-doctor-followup-web-push-on-notification` |
| Schema and table | `public.doctor_notifications` |
| Events | `INSERT` only |
| Method | `POST` |
| Target | `https://REPLACE_WITH_PROJECT_REF.supabase.co/functions/v1/send-doctor-followup-web-push` |
| Header | `Content-Type: application/json` |
| Header | `x-webhook-secret: <existing WEB_PUSH_WEBHOOK_SECRET value>` |

Do not configure UPDATE or DELETE events. No `pg_net`, database trigger, or
direct call from `process_due_medication_followup_alerts()` is required.

## Delivery Behavior

- Due Today, Recently Overdue, High, and Critical types are eligible.
- Unsupported current or future Doctor notification types are skipped.
- Each active Doctor device is claimed independently.
- Sent and processing rows cannot be reclaimed.
- `retryable_failure` rows may be reclaimed up to five total attempts.
- HTTP 429, 5xx, and transport failures remain retryable.
- HTTP 404 and 410 mark only that endpoint inactive and record `expired`.
- Other provider rejections are permanent for that notification/device pair.
- One device failure does not stop attempts for the Doctor's other devices.
- Web Push failure does not remove, alter, or mark the in-app notification read.

## Manual Tests

### A. Enable Doctor Push

1. Install the reviewed SQL and deploy the reviewed function manually.
2. Configure the INSERT-only webhook with the existing secret.
3. Sign in as an active Doctor and open the notification bell.
4. Select **Enable**, approve permission, and confirm the control reports that
   this device is enabled.
5. Confirm one active subscription exists for that Doctor and endpoint.

### B. Recently Overdue

1. Create or reschedule an assigned follow-up to a recent past time without an
   active snooze.
2. Manually run `select * from public.process_due_medication_followup_alerts();`.
3. Confirm one in-app notification and one system push.
4. Select the push and confirm the exact follow-up opens at the validated
   `/doctor/follow-ups` escalation URL.

### C. Duplicate Protection

1. Run the processor again.
2. Safely reinvoke the webhook/function for the same notification ID.
3. Confirm no second successful delivery for the same subscription.

### D. Multiple Devices

1. Enable push in two Doctor browsers.
2. Generate a new eligible escalation cycle.
3. Confirm each active device receives one push and has one ledger row.

### E. Disable

1. Disable push in one browser.
2. Generate a new alert.
3. Confirm that browser receives nothing and the other active device still
   receives one push.

### F. Snooze

1. Snooze an overdue follow-up and run the processor.
2. Confirm no Doctor notification exists, so no push or delivery claim exists.

### G. Resolve

1. Resolve a follow-up and run the processor.
2. Confirm no Doctor notification and no push are created.

### H. Expired Endpoint

1. Use an expired test subscription only in a controlled environment.
2. Confirm a 404/410 deactivates only that endpoint and other devices continue.

### I. Isolation

1. Sign in as another Doctor and confirm the first Doctor's subscriptions,
   notifications, deliveries, and follow-up cannot be accessed.
2. Sign in as Patient and confirm Patient inbox, subscription, push, and click
   behavior is unchanged.
