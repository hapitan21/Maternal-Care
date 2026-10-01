# Patient native push sender setup

`send-patient-native-push` is the server-only Android FCM HTTP v1 delivery path
for rows already created in `public.patient_notifications`. It is separate from
the existing browser Web Push sender and must use a separate webhook secret.

Do not place a Firebase service-account file, private key, OAuth token, FCM
registration token, or real webhook secret in Git, React/Vite variables,
Android assets, documentation, shell history, or logs.

## Required Supabase secrets

- `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete service-account JSON stored as
  one Supabase secret. The sender validates and uses only `project_id`,
  `client_email`, `private_key`, and optional `private_key_id`.
- `NATIVE_PUSH_WEBHOOK_SECRET`: a long, independently generated random value
  used only by the native-push Database Webhook.

The Firebase service account must belong to, or be granted narrowly scoped FCM
send access to, the Android application's Firebase project. Enable the Firebase
Cloud Messaging API and grant only the permission required to create FCM
messages. Never use the Android client API key or `google-services.json` for
server authentication.

Set production secrets through the Supabase Dashboard or an ignored local env
file. To avoid putting JSON/private keys in command history, prefer:

```sh
supabase secrets set --env-file <ignored-native-push-env-file>
```

The ignored file must define `FIREBASE_SERVICE_ACCOUNT_JSON` and
`NATIVE_PUSH_WEBHOOK_SECRET`. Do not commit it.

## Migration and local validation

Review and apply the native delivery-ledger migration before invoking the
function. For a linked project, preview migration work first:

```sh
supabase db push --dry-run
```

When Docker and the Supabase local Edge runtime are available, serve the
function with an ignored local env file and JWT gateway verification disabled.
The handler still requires `x-webhook-secret`:

```sh
supabase functions serve send-patient-native-push --no-verify-jwt --env-file <ignored-native-push-env-file>
```

Test rejection of wrong methods, missing/incorrect secrets, malformed JSON,
wrong event/table/schema values, and invalid notification UUIDs before testing
against Firebase. Then validate canonical notification lookup, duplicate claim
skipping, multiple enabled installations, invalid-token disable, and aggregate
responses.

## Future deployment

Do not run these steps until the migration, secrets, and physical-device test
plan have been reviewed.

```sh
supabase functions deploy send-patient-native-push --no-verify-jwt
```

The deployed function is not authenticated by `verify_jwt`; it authenticates
the Database Webhook with the separate `x-webhook-secret` value. Knowing the
function URL alone is insufficient to pass this check.

## Future Database Webhook

Create this only after the function is deployed and the production secrets are
set:

| Setting | Value |
| --- | --- |
| Name | `send-patient-native-push-on-notification` |
| Schema | `public` |
| Table | `patient_notifications` |
| Event | `INSERT` only |
| Method | `POST` |
| Destination | Deployed `send-patient-native-push` Edge Function |
| Header | `x-webhook-secret: <same value as NATIVE_PUSH_WEBHOOK_SECRET>` |

Use a separate Dashboard webhook from `send-patient-web-push`. Do not change or
remove the existing Web Push webhook.

The native handler accepts only the webhook notification UUID. It re-fetches
the canonical `patient_notifications` row, derives Patient ownership and a
hard-coded safe route, and queries only enabled Android registrations belonging
to that Patient.

## Privacy-safe message

Every native message uses the same lock-screen copy:

- Title: `Maternal Care`
- Body: `You have a new reminder. Open Maternal Care to view details.`

The data payload contains only string values for `notification_id`, an
allowlisted `notification_type`, and a hard-coded allowlisted `route`. It does
not contain Patient identifiers, names, database title/message values, related
entity IDs, medication details, diagnoses, laboratory content, pregnancy data,
notes, or other clinical text.

## Production verification

After deployment and webhook creation:

1. Send one canonical notification to a dedicated test Patient and verify its
   in-app row and Android system notification.
2. Test foreground, background, and killed app states. Tap/deep-link routing is
   intentionally not implemented by this phase.
3. Test two enabled Android installations; one device failure must not block the
   other.
4. Replay the same webhook and confirm the unique notification/device claim is
   skipped rather than sent again.
5. Invalidate only a dedicated test token, then verify its device row is updated
   to `enabled = false` without being deleted.
6. Confirm function logs and ledger rows contain no FCM tokens, Patient IDs,
   notification content, credentials, JWT assertions, or OAuth tokens.

Commit and push only after these runtime checks pass.
