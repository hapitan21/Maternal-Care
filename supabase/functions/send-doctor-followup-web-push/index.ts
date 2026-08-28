import { createClient } from "@supabase/supabase-js";
import {
  configureWebPushFromEnvironment,
  getPushStatus,
  getRequiredEnvironment,
  getSafePushFailure,
  getSupabaseAdminKey,
  sendWebPushNotification,
  timingSafeEqual,
  WebPushConfigurationError,
} from "../_shared/webPushDelivery.ts";

const FOLLOWUP_TYPES = {
  medication_followup_due_today: {
    escalation: "due_today",
    title: "Medication Follow-up Due Today",
  },
  medication_followup_recently_overdue: {
    escalation: "recently_overdue",
    title: "Medication Follow-up Overdue",
  },
  medication_followup_high: {
    escalation: "high",
    title: "High-Priority Follow-up Alert",
  },
  medication_followup_critical: {
    escalation: "critical",
    title: "Critical Follow-up Alert",
  },
} as const;

const PRIVACY_SAFE_BODY =
  "A medication follow-up assigned to you requires attention. Open Maternal Care to review it securely.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_DELIVERY_ATTEMPTS = 5;

type JsonObject = Record<string, unknown>;
type FollowupType = keyof typeof FOLLOWUP_TYPES;

type DoctorNotificationRow = {
  id: string;
  doctor_id: string;
  followup_id: string | null;
  notification_type: string;
  target_path: string;
};

type DoctorSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  failure_count: number;
};

type DeliveryClaim = {
  delivery_id: string;
  attempt_count: number;
};

type DeliverySummary = {
  ok: true;
  notification_id: string;
  examined_subscriptions: number;
  claimed: number;
  sent: number;
  duplicates_skipped: number;
  deactivated: number;
  retryable_failures: number;
  permanent_failures: number;
  reason?: "unsupported_notification_type" | "no_active_subscriptions";
};

class RequestFailure extends Error {
  status: number;
  publicCode: string;

  constructor(status: number, publicCode: string) {
    super(publicCode);
    this.name = "RequestFailure";
    this.status = status;
    this.publicCode = publicCode;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNotificationId(payload: unknown): string {
  if (!isJsonObject(payload)) {
    throw new RequestFailure(400, "invalid_webhook_payload");
  }

  if (
    payload.type !== "INSERT" ||
    payload.schema !== "public" ||
    payload.table !== "doctor_notifications" ||
    !isJsonObject(payload.record)
  ) {
    throw new RequestFailure(400, "unsupported_webhook_event");
  }

  if (payload.old_record !== null && payload.old_record !== undefined) {
    throw new RequestFailure(400, "invalid_webhook_payload");
  }

  const notificationId = payload.record.id;
  if (typeof notificationId !== "string" || !UUID_PATTERN.test(notificationId)) {
    throw new RequestFailure(400, "invalid_notification_id");
  }

  return notificationId;
}

function isFollowupType(value: string): value is FollowupType {
  return Object.prototype.hasOwnProperty.call(FOLLOWUP_TYPES, value);
}

function getSafeTargetPath(
  notification: DoctorNotificationRow,
  escalation: string,
): string {
  if (!notification.followup_id || !UUID_PATTERN.test(notification.followup_id)) {
    throw new RequestFailure(422, "invalid_notification_record");
  }

  let parsed: URL;
  try {
    parsed = new URL(notification.target_path, "https://maternal-care.internal");
  } catch {
    throw new RequestFailure(422, "invalid_notification_target");
  }

  const keys = Array.from(parsed.searchParams.keys());
  const followupId = parsed.searchParams.get("followupId");
  if (
    parsed.origin !== "https://maternal-care.internal" ||
    parsed.pathname !== "/doctor/follow-ups" ||
    parsed.hash ||
    keys.length !== 2 ||
    !keys.includes("escalation") ||
    !keys.includes("followupId") ||
    parsed.searchParams.get("escalation") !== escalation ||
    followupId !== notification.followup_id
  ) {
    throw new RequestFailure(422, "invalid_notification_target");
  }

  const safeParams = new URLSearchParams({
    escalation,
    followupId: notification.followup_id,
  });
  return `/doctor/follow-ups?${safeParams.toString()}`;
}

function getEmptySummary(notificationId: string): DeliverySummary {
  return {
    ok: true,
    notification_id: notificationId,
    examined_subscriptions: 0,
    claimed: 0,
    sent: 0,
    duplicates_skipped: 0,
    deactivated: 0,
    retryable_failures: 0,
    permanent_failures: 0,
  };
}

function isRetryableStatus(status: number | null): boolean {
  return status === null || status === 429 || (status !== null && status >= 500);
}

Deno.serve(async (request: Request): Promise<Response> => {
  const executionId = crypto.randomUUID();

  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const expectedSecret = getRequiredEnvironment("WEB_PUSH_WEBHOOK_SECRET");
    const suppliedSecret = request.headers.get("x-webhook-secret");
    if (
      !suppliedSecret ||
      !(await timingSafeEqual(suppliedSecret, expectedSecret))
    ) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    let webhookPayload: unknown;
    try {
      webhookPayload = await request.json();
    } catch {
      throw new RequestFailure(400, "invalid_json");
    }

    const notificationId = getNotificationId(webhookPayload);

    const supabase = createClient(
      getRequiredEnvironment("SUPABASE_URL"),
      getSupabaseAdminKey(),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: notificationData, error: notificationError } = await supabase
      .from("doctor_notifications")
      .select("id, doctor_id, followup_id, notification_type, target_path")
      .eq("id", notificationId)
      .maybeSingle();

    if (notificationError) throw new RequestFailure(500, "database_error");
    if (!notificationData) throw new RequestFailure(404, "notification_not_found");

    const notification = notificationData as DoctorNotificationRow;
    const summary = getEmptySummary(notification.id);
    if (!isFollowupType(notification.notification_type)) {
      summary.reason = "unsupported_notification_type";
      return jsonResponse(summary);
    }

    const presentation = FOLLOWUP_TYPES[notification.notification_type];
    const targetPath = getSafeTargetPath(notification, presentation.escalation);

    const { data: doctor, error: doctorError } = await supabase
      .from("profiles")
      .select("id, role, account_status")
      .eq("id", notification.doctor_id)
      .maybeSingle();

    if (doctorError) throw new RequestFailure(500, "database_error");
    if (
      !doctor ||
      String(doctor.role || "").trim().toLowerCase() !== "doctor" ||
      String(doctor.account_status || "").trim().toLowerCase() !== "active"
    ) {
      throw new RequestFailure(403, "doctor_not_eligible");
    }

    const { data: subscriptionData, error: subscriptionError } = await supabase
      .from("doctor_push_subscriptions")
      .select("id, endpoint, p256dh, auth_key, failure_count")
      .eq("doctor_id", notification.doctor_id)
      .eq("is_active", true);

    if (subscriptionError) throw new RequestFailure(500, "database_error");

    const subscriptions = (subscriptionData ?? []) as DoctorSubscriptionRow[];
    summary.examined_subscriptions = subscriptions.length;
    if (!subscriptions.length) {
      summary.reason = "no_active_subscriptions";
      return jsonResponse(summary);
    }

    configureWebPushFromEnvironment();

    const pushPayload = JSON.stringify({
      audience: "doctor",
      notificationId: notification.id,
      title: presentation.title,
      body: PRIVACY_SAFE_BODY,
      url: targetPath,
      escalation: presentation.escalation,
      tag: `doctor-followup-${notification.id}`,
    });

    console.info("Doctor follow-up Web Push request accepted", {
      executionId,
      notificationId: notification.id,
      notificationType: notification.notification_type,
      subscriptions: subscriptions.length,
    });

    for (const subscription of subscriptions) {
      try {
        const { data: claimData, error: claimError } = await supabase.rpc(
          "claim_doctor_notification_push_delivery",
          {
            p_notification_id: notification.id,
            p_subscription_id: subscription.id,
            p_max_attempts: MAX_DELIVERY_ATTEMPTS,
          },
        ).maybeSingle();

        if (claimError) {
          summary.permanent_failures += 1;
          console.error("Doctor Web Push delivery claim failed", {
            executionId,
            notificationId: notification.id,
            subscriptionId: subscription.id,
          });
          continue;
        }

        if (!claimData) {
          summary.duplicates_skipped += 1;
          continue;
        }

        const claim = claimData as DeliveryClaim;
        summary.claimed += 1;
        let providerStatus: number | null = null;

        try {
          providerStatus = await sendWebPushNotification(
            {
              endpoint: subscription.endpoint,
              p256dh: subscription.p256dh,
              authKey: subscription.auth_key,
            },
            pushPayload,
            "high",
          );
        } catch (error) {
          providerStatus = getPushStatus(error);
          const safeFailure = getSafePushFailure(providerStatus);
          const expired = providerStatus === 404 || providerStatus === 410;
          const retryable =
            !expired &&
            claim.attempt_count < MAX_DELIVERY_ATTEMPTS &&
            isRetryableStatus(providerStatus);
          const failureStatus = expired
            ? "expired"
            : retryable
              ? "retryable_failure"
              : "permanent_failure";

          const subscriptionUpdate = expired
            ? { is_active: false, failure_count: subscription.failure_count + 1 }
            : { failure_count: subscription.failure_count + 1 };
          const { error: subscriptionUpdateError } = await supabase
            .from("doctor_push_subscriptions")
            .update(subscriptionUpdate)
            .eq("id", subscription.id)
            .eq("doctor_id", notification.doctor_id);

          const { error: deliveryUpdateError } = await supabase
            .from("doctor_notification_push_deliveries")
            .update({
              status: failureStatus,
              provider_status: providerStatus,
              error_code: safeFailure.code,
              error_message: safeFailure.message,
            })
            .eq("id", claim.delivery_id);

          if (expired && !subscriptionUpdateError) summary.deactivated += 1;
          if (retryable) summary.retryable_failures += 1;
          else summary.permanent_failures += 1;

          console.warn("Doctor Web Push device delivery failed", {
            executionId,
            notificationId: notification.id,
            subscriptionId: subscription.id,
            attempt: claim.attempt_count,
            providerStatus,
            outcome: failureStatus,
            stateRecorded: !deliveryUpdateError,
            subscriptionUpdated: !subscriptionUpdateError,
          });
          continue;
        }

        const sentAt = new Date().toISOString();
        const [{ error: deliveryUpdateError }, { error: subscriptionUpdateError }] =
          await Promise.all([
            supabase
              .from("doctor_notification_push_deliveries")
              .update({
                status: "sent",
                provider_status: providerStatus,
                error_code: null,
                error_message: null,
                sent_at: sentAt,
              })
              .eq("id", claim.delivery_id),
            supabase
              .from("doctor_push_subscriptions")
              .update({
                last_success_at: sentAt,
                failure_count: 0,
                last_seen_at: sentAt,
              })
              .eq("id", subscription.id)
              .eq("doctor_id", notification.doctor_id),
          ]);

        summary.sent += 1;
        if (deliveryUpdateError || subscriptionUpdateError) {
          console.error("Doctor Web Push success metadata update failed", {
            executionId,
            notificationId: notification.id,
            subscriptionId: subscription.id,
            deliveryRecorded: !deliveryUpdateError,
            subscriptionUpdated: !subscriptionUpdateError,
          });
        }
      } catch {
        summary.permanent_failures += 1;
        console.error("Doctor Web Push device processing failed", {
          executionId,
          notificationId: notification.id,
          subscriptionId: subscription.id,
        });
      }
    }

    console.info("Doctor follow-up Web Push request completed", {
      executionId,
      notificationId: notification.id,
      examinedSubscriptions: summary.examined_subscriptions,
      claimed: summary.claimed,
      sent: summary.sent,
      duplicatesSkipped: summary.duplicates_skipped,
      deactivated: summary.deactivated,
      retryableFailures: summary.retryable_failures,
      permanentFailures: summary.permanent_failures,
    });

    return jsonResponse(summary);
  } catch (error) {
    if (error instanceof WebPushConfigurationError) {
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }
    if (error instanceof RequestFailure) {
      return jsonResponse({ ok: false, error: error.publicCode }, error.status);
    }

    console.error("Doctor follow-up Web Push request failed", {
      executionId,
      error: "internal_error",
    });
    return jsonResponse({ ok: false, error: "internal_error", executionId }, 500);
  }
});
