import { createClient } from "@supabase/supabase-js";
import {
  configureWebPushFromEnvironment,
  getPushStatus,
  getRequiredEnvironment,
  getSafePushFailure,
  getSupabaseAdminKey,
  isUniqueViolation,
  sendWebPushNotification,
  timingSafeEqual,
  WebPushConfigurationError,
} from "../_shared/webPushDelivery.ts";

const NOTIFICATION_TYPES = [
  "appointment_created",
  "appointment_reminder",
  "appointment_rescheduled",
  "appointment_cancelled",
  "medication_reminder",
  "doctor_reminder",
  "health_tip",
  "medical_record_available",
  "laboratory_result_available",
  "prescription_available",
  "account_notification",
  "general",
] as const;

const NOTIFICATION_PRIORITIES = ["normal", "important", "urgent"] as const;

const ALLOWED_TARGETS = new Set([
  "/patient/dashboard",
  "/patient/appointments",
  "/patient/reminders",
  "/patient/medical-records",
  "/patient/profile",
  "/patient/settings",
]);

const PRIVACY_SAFE_BODIES: Record<NotificationType, string> = {
  appointment_created:
    "A new clinic appointment has been scheduled for you.",
  appointment_reminder: "You have an upcoming clinic appointment.",
  appointment_rescheduled:
    "Your clinic appointment schedule has been updated.",
  appointment_cancelled: "Your clinic appointment has been cancelled.",
  medication_reminder:
    "You have a medication reminder. Tap to view it securely.",
  doctor_reminder:
    "You have a new reminder from your healthcare provider.",
  health_tip: "A new maternal health tip is available.",
  medical_record_available:
    "A new medical record is available. Tap to view it securely.",
  laboratory_result_available:
    "A new laboratory result is available. Tap to view it securely.",
  prescription_available:
    "A new prescription is available. Tap to view it securely.",
  account_notification: "You have an account notification.",
  general: "You have a new notification. Tap to view it securely.",
};

const TYPE_TARGETS: Record<NotificationType, string> = {
  appointment_created: "/patient/appointments",
  appointment_reminder: "/patient/appointments",
  appointment_rescheduled: "/patient/appointments",
  appointment_cancelled: "/patient/appointments",
  medication_reminder: "/patient/reminders",
  doctor_reminder: "/patient/reminders",
  health_tip: "/patient/reminders",
  medical_record_available: "/patient/medical-records",
  laboratory_result_available: "/patient/medical-records",
  prescription_available: "/patient/medical-records",
  account_notification: "/patient/profile",
  general: "/patient/reminders",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

type NotificationType = (typeof NOTIFICATION_TYPES)[number];
type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
type JsonObject = Record<string, unknown>;

type ValidNotification = {
  id: string;
  patientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  targetPath: string;
};

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
};

type DeliverySummary = {
  ok: true;
  notificationId: string;
  subscriptions: number;
  sent: number;
  expired: number;
  failed: number;
  skippedDuplicate: number;
  reason?: "no_active_subscriptions";
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

class DatabaseFailure extends Error {
  operation: string;

  constructor(operation: string) {
    super("database_error");
    this.name = "DatabaseFailure";
    this.operation = operation;
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

function isNotificationType(value: unknown): value is NotificationType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

function isNotificationPriority(
  value: unknown,
): value is NotificationPriority {
  return (
    typeof value === "string" &&
    (NOTIFICATION_PRIORITIES as readonly string[]).includes(value)
  );
}

function getMappedTarget(
  type: NotificationType,
  requestedTarget: unknown,
): string {
  if (
    typeof requestedTarget === "string" &&
    ALLOWED_TARGETS.has(requestedTarget)
  ) {
    return requestedTarget;
  }

  return TYPE_TARGETS[type];
}

function validateWebhookPayload(payload: unknown): ValidNotification {
  if (!isJsonObject(payload)) {
    throw new RequestFailure(400, "invalid_webhook_payload");
  }

  if (
    payload.type !== "INSERT" ||
    payload.schema !== "public" ||
    payload.table !== "patient_notifications" ||
    !isJsonObject(payload.record)
  ) {
    throw new RequestFailure(400, "unsupported_webhook_event");
  }

  if (payload.old_record !== null && payload.old_record !== undefined) {
    throw new RequestFailure(400, "invalid_webhook_payload");
  }

  const record = payload.record;
  if (
    typeof record.id !== "string" ||
    !UUID_PATTERN.test(record.id) ||
    typeof record.patient_id !== "string" ||
    !UUID_PATTERN.test(record.patient_id) ||
    !isNotificationType(record.type) ||
    !isNotificationPriority(record.priority)
  ) {
    throw new RequestFailure(400, "invalid_notification_record");
  }

  if (
    record.target_path !== null &&
    record.target_path !== undefined &&
    typeof record.target_path !== "string"
  ) {
    throw new RequestFailure(400, "invalid_notification_target");
  }

  return {
    id: record.id,
    patientId: record.patient_id,
    type: record.type,
    priority: record.priority,
    targetPath: getMappedTarget(record.type, record.target_path),
  };
}

function getUrgency(priority: NotificationPriority): "normal" | "high" {
  return priority === "normal" ? "normal" : "high";
}

Deno.serve(async (request: Request): Promise<Response> => {
  const executionId = crypto.randomUUID();

  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const expectedWebhookSecret = getRequiredEnvironment(
      "WEB_PUSH_WEBHOOK_SECRET",
    );
    const suppliedWebhookSecret = request.headers.get("x-webhook-secret");

    if (
      !suppliedWebhookSecret ||
      !(await timingSafeEqual(suppliedWebhookSecret, expectedWebhookSecret))
    ) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    let requestPayload: unknown;
    try {
      requestPayload = await request.json();
    } catch {
      throw new RequestFailure(400, "invalid_json");
    }

    const notification = validateWebhookPayload(requestPayload);
    const supabaseUrl = getRequiredEnvironment("SUPABASE_URL");
    const serviceRoleKey = getSupabaseAdminKey();
    configureWebPushFromEnvironment();

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: subscriptionData, error: subscriptionError } = await supabase
      .from("patient_push_subscriptions")
      .select("id, endpoint, p256dh, auth_key")
      .eq("patient_id", notification.patientId)
      .eq("is_active", true);

    if (subscriptionError) {
      throw new DatabaseFailure("load_subscriptions");
    }

    const subscriptions = (subscriptionData ?? []) as PushSubscriptionRow[];
    const summary: DeliverySummary = {
      ok: true,
      notificationId: notification.id,
      subscriptions: subscriptions.length,
      sent: 0,
      expired: 0,
      failed: 0,
      skippedDuplicate: 0,
    };

    console.info("Patient Web Push request accepted", {
      executionId,
      notificationId: notification.id,
      notificationType: notification.type,
      patientId: notification.patientId,
      subscriptions: subscriptions.length,
    });

    if (subscriptions.length === 0) {
      summary.reason = "no_active_subscriptions";
      return jsonResponse(summary);
    }

    const pushPayload = JSON.stringify({
      notificationId: notification.id,
      title: "Maternal Care",
      body: PRIVACY_SAFE_BODIES[notification.type],
      type: notification.type,
      url: notification.targetPath,
      tag: `patient-notification-${notification.id}`,
      priority: notification.priority,
    });

    for (const subscription of subscriptions) {
      const { data: claim, error: claimError } = await supabase
        .from("patient_notification_push_deliveries")
        .insert({
          notification_id: notification.id,
          subscription_id: subscription.id,
          status: "processing",
          attempt_count: 1,
        })
        .select("id")
        .single();

      if (claimError) {
        if (isUniqueViolation(claimError)) {
          summary.skippedDuplicate += 1;
          continue;
        }
        throw new DatabaseFailure("claim_delivery");
      }

      let pushStatus: number | null = null;

      try {
        pushStatus = await sendWebPushNotification(
          {
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            authKey: subscription.auth_key,
          },
          pushPayload,
          getUrgency(notification.priority),
        );
      } catch (error) {
        pushStatus = getPushStatus(error);
        const safeFailure = getSafePushFailure(pushStatus);
        const expired = pushStatus === 404 || pushStatus === 410;

        if (expired) {
          const { error: deactivateError } = await supabase
            .from("patient_push_subscriptions")
            .update({
              is_active: false,
              updated_at: new Date().toISOString(),
            })
            .eq("id", subscription.id);

          if (deactivateError) {
            throw new DatabaseFailure("deactivate_subscription");
          }
        }

        const { error: deliveryError } = await supabase
          .from("patient_notification_push_deliveries")
          .update({
            status: expired ? "expired" : "failed",
            push_service_status: pushStatus,
            error_code: safeFailure.code,
            error_message: safeFailure.message,
          })
          .eq("id", claim.id);

        if (deliveryError) {
          throw new DatabaseFailure("record_delivery_failure");
        }

        if (expired) {
          summary.expired += 1;
        } else {
          summary.failed += 1;
        }

        console.warn("Patient Web Push device delivery failed", {
          executionId,
          notificationId: notification.id,
          subscriptionId: subscription.id,
          status: pushStatus,
          outcome: expired ? "expired" : "failed",
        });
        continue;
      }

      const { error: sentUpdateError } = await supabase
        .from("patient_notification_push_deliveries")
        .update({
          status: "sent",
          push_service_status: pushStatus,
          error_code: null,
          error_message: null,
          sent_at: new Date().toISOString(),
        })
        .eq("id", claim.id);

      if (sentUpdateError) {
        throw new DatabaseFailure("record_delivery_success");
      }

      summary.sent += 1;
    }

    console.info("Patient Web Push request completed", {
      executionId,
      notificationId: notification.id,
      subscriptions: summary.subscriptions,
      sent: summary.sent,
      expired: summary.expired,
      failed: summary.failed,
      skippedDuplicate: summary.skippedDuplicate,
    });

    return jsonResponse(summary);
  } catch (error) {
    if (error instanceof WebPushConfigurationError) {
      return jsonResponse(
        { ok: false, error: "server_configuration_error" },
        500,
      );
    }

    if (error instanceof RequestFailure) {
      return jsonResponse({ ok: false, error: error.publicCode }, error.status);
    }

    if (error instanceof DatabaseFailure) {
      console.error("Patient Web Push database operation failed", {
        executionId,
        operation: error.operation,
      });
    } else {
      console.error("Patient Web Push request failed", {
        executionId,
        error: "internal_error",
      });
    }

    return jsonResponse(
      { ok: false, error: "internal_error", executionId },
      500,
    );
  }
});
