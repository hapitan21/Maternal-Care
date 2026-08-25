# Patient Web Push Webhook Setup

Phase 3B adds a server-side Supabase Edge Function that converts new
`public.patient_notifications` rows into privacy-safe Web Push messages. The
function is not a public direct-send API: Database Webhook requests must include
the configured shared secret.

Nothing in this guide is run automatically. Review the SQL, function source,
project settings, and secrets before applying them to a Supabase project.

## Security Model

- JWT verification is disabled only for `send-patient-web-push` because the
  caller is a Database Webhook, not a signed-in browser.
- Every request must include `x-webhook-secret`, which is compared with
  `WEB_PUSH_WEBHOOK_SECRET`.
- The function uses `SUPABASE_SERVICE_ROLE_KEY` only in the hosted server
  environment.
- Browser code receives only the VAPID public key. The VAPID private key,
  service-role key, and webhook secret must never be added to a Vite variable.
- Push previews contain a generic message selected from the notification type;
  the saved in-app `message` is never sent to the lock screen.
- Delivery rows are server-only. RLS is enabled with no client policies, and
  direct privileges are revoked from `public`, `anon`, and `authenticated`.

## 1. Review and Apply the SQL Manually

Open `supabase_patient_web_push_deliveries.sql` and complete its pre-flight
checklist. Run it manually in the correct Supabase project only after review.
It creates `public.patient_notification_push_deliveries`.

The unique `(notification_id, subscription_id)` constraint is the delivery
claim. A repeated webhook invocation cannot claim the same device twice, so the
function skips that push as `skippedDuplicate`.

No SQL is executed by the Edge Function deployment.

## 2. Prepare Secrets

Generate one VAPID key pair if the production project does not already have
one. The public key must be exactly the same value configured as
`VITE_WEB_PUSH_PUBLIC_KEY` in the Patient PWA.

Do not regenerate the pair after Patients subscribe. A changed key pair
invalidates the relationship with existing subscriptions, so Patients must
subscribe again.

Use a long, cryptographically random value for `WEB_PUSH_WEBHOOK_SECRET`.
`WEB_PUSH_VAPID_SUBJECT` must be a contact URI such as
`mailto:clinic@example.com` or a production HTTPS clinic URL.

The committed placeholder file is:

```text
supabase/functions/.env.web-push.example
```

For local work, create an ignored file such as:

```text
supabase/functions/.env.web-push.local
```

Never put real values in the example file. The repository `.gitignore` ignores
the local secret file.

Hosted Edge Functions provide `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Do not place either value in React or a public
environment file.

## 3. Link and Set Hosted Secrets

Run these commands later from the project directory in PowerShell, replacing
every placeholder:

```powershell
supabase login
supabase link --project-ref REPLACE_WITH_PROJECT_REF

supabase secrets set `
  WEB_PUSH_VAPID_PUBLIC_KEY="REPLACE" `
  WEB_PUSH_VAPID_PRIVATE_KEY="REPLACE" `
  WEB_PUSH_VAPID_SUBJECT="mailto:REPLACE" `
  WEB_PUSH_WEBHOOK_SECRET="REPLACE_WITH_LONG_RANDOM_SECRET"
```

Confirm secrets with the Supabase Dashboard or CLI without printing their
values into logs, screenshots, tickets, or chat.

## 4. Local Function Validation

Local Edge Function serving requires the Supabase CLI and Docker or a
compatible runtime. Populate the ignored local secret file, including local
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` values, then run:

```powershell
supabase functions serve send-patient-web-push `
  --env-file supabase/functions/.env.web-push.local `
  --no-verify-jwt
```

Use a placeholder request to validate authentication and payload handling:

```powershell
$headers = @{
  "Content-Type" = "application/json"
  "x-webhook-secret" = "REPLACE_WITH_LOCAL_TEST_SECRET"
}

$body = @{
  type = "INSERT"
  table = "patient_notifications"
  schema = "public"
  record = @{
    id = "00000000-0000-4000-8000-000000000001"
    patient_id = "00000000-0000-4000-8000-000000000002"
    type = "general"
    target_path = $null
    priority = "normal"
  }
  old_record = $null
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:54321/functions/v1/send-patient-web-push" `
  -Headers $headers `
  -Body $body
```

The placeholder UUIDs will not match real rows. A real send test requires an
existing `patient_notifications` row and an actual active subscription already
stored in Supabase. Never commit endpoint, `p256dh`, or `auth_key` fixtures.

## 5. Deploy the Function Manually

After local validation:

```powershell
supabase functions deploy send-patient-web-push --no-verify-jwt
```

The expected target is:

```text
https://REPLACE_WITH_PROJECT_REF.supabase.co/functions/v1/send-patient-web-push
```

The `--no-verify-jwt` setting is intentional for the Database Webhook. The
function's shared-secret check remains mandatory.

## 6. Create the Database Webhook Manually

In Supabase Dashboard, open **Database > Webhooks** and create:

| Setting | Value |
| --- | --- |
| Name | `send-patient-web-push-on-notification` |
| Schema and table | `public.patient_notifications` |
| Events | `INSERT` only |
| Method | `POST` |
| Target | Deployed `send-patient-web-push` function URL |
| Header | `Content-Type: application/json` |
| Header | `x-webhook-secret: <same secret stored in WEB_PUSH_WEBHOOK_SECRET>` |

Enter the secret directly in the Dashboard. Do not commit it or include it in
documentation. Do not enable UPDATE or DELETE events.

## Delivery Behavior

The function queries active rows in `public.patient_push_subscriptions` for the
notification's Patient. It sends one encrypted `aes128gcm` payload per claimed
device with a 24-hour TTL. `normal` priority uses normal urgency;
`important` and `urgent` use high urgency.

HTTP 404 and 410 responses mark the delivery `expired` and set only that
subscription's `is_active` value to false. Other failures are recorded with a
short sanitized code and message; 429 and 5xx responses do not deactivate the
device. Processing continues for the Patient's other subscriptions.

The response contains only aggregate fields:

```json
{
  "ok": true,
  "notificationId": "00000000-0000-4000-8000-000000000001",
  "subscriptions": 2,
  "sent": 1,
  "expired": 0,
  "failed": 0,
  "skippedDuplicate": 1
}
```

No subscription endpoint, encryption key, secret, notification message, or
provider response body is returned.

## Manual End-to-End Test Plan

1. Review and manually run `supabase_patient_web_push_deliveries.sql`.
2. Confirm one active Patient push subscription exists.
3. Set the four Edge Function Web Push secrets.
4. Deploy `send-patient-web-push`.
5. Create the INSERT-only Database Webhook.
6. Keep the Patient browser subscribed.
7. Close or minimize the Patient PWA.
8. Log in as Doctor or Staff in another session.
9. Create an appointment or send a manual notification.
10. Confirm a `patient_notifications` row is created.
11. Confirm one delivery row exists for each active device.
12. Confirm each successful delivery status becomes `sent`.
13. Confirm the system notification appears.
14. Click the notification.
15. Confirm the Patient PWA opens the correct allowlisted route.
16. Confirm no sensitive clinical information appears on the lock screen.
17. Repeat the same webhook request and confirm no duplicate push is sent.
18. Disable the Patient device and confirm no push is attempted.
19. Test a removed or expired subscription and confirm it becomes inactive.
20. Confirm normal in-app Realtime notifications still work.

Desktop subscriptions may use `localhost`. Phone testing requires a deployed
HTTPS Patient PWA; an insecure LAN HTTP address is not a valid production push
test environment.
