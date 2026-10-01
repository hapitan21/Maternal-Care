import { createClient } from "@supabase/supabase-js";
import {
  FirebaseConfigurationError,
  type FirebaseSendResult,
  getFirebaseAuthorization,
  sendFirebaseMessage,
} from "../_shared/firebaseMessaging.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const DEVICE_CONCURRENCY = 5;

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

type NotificationType = (typeof NOTIFICATION_TYPES)[number];
type JsonObject = Record<string, unknown>;

type CanonicalNotificationRow = {
  id: string;
  patient_id: string;
  type: string;
};

type NativeDeviceRow = {
  id: string;
  push_token: string;
  updated_at: string;
};

type DeliveryOutcome = {
  attempted: boolean;
  result: "sent" | "failed" | "disabled_token" | "skipped";
};

type DeliverySummary = {
  ok: true;
  notificationId: string;
  attempted: number;
  sent: number;
  failed: number;
  disabledTokens: number;
  skipped: number;
  reason?: "no_active_devices";
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

class ServerConfigurationError extends Error {
  constructor() {
    super("server_configuration_error");
    this.name = "ServerConfigurationError";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function getRequiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ServerConfigurationError();
  return value;
}

function getSupabaseAdminKey(): string {
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();

  if (secretKeysJson) {
    try {
      const parsed: unknown = JSON.parse(secretKeysJson);
      if (
        isJsonObject(parsed) &&
        typeof parsed.default === "string" &&
        parsed.default.trim()
      ) {
        return parsed.default.trim();
      }
    } catch {
      throw new ServerConfigurationError();
    }
    throw new ServerConfigurationError();
  }

  const localSecretKey = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (localSecretKey) return localSecretKey;
  return getRequiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
}

async function timingSafeEqual(
  suppliedValue: string,
  expectedValue: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(suppliedValue)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedValue)),
  ]);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let mismatch = suppliedValue.length ^ expectedValue.length;

  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= suppliedBytes[index] ^ expectedBytes[index];
  }
  return mismatch === 0;
}

function isUniqueViolation(error: unknown): boolean {
  return isJsonObject(error) && error.code === "23505";
}

function validateWebhookPayload(payload: unknown): string {
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

  const notificationId = payload.record.id;
  if (
    typeof notificationId !== "string" || !UUID_PATTERN.test(notificationId)
  ) {
    throw new RequestFailure(400, "invalid_notification_id");
  }
  return notificationId;
}

function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

function getNativeNotificationMetadata(rawType: string): {
  type: NotificationType;
  route: string;
} {
  const type: NotificationType = isNotificationType(rawType)
    ? rawType
    : "general";
  switch (type) {
    case "appointment_created":
    case "appointment_reminder":
    case "appointment_rescheduled":
    case "appointment_cancelled":
      return { type, route: "/patient/appointments" };
    case "medication_reminder":
      return { type, route: "/patient/reminders/medications" };
    case "doctor_reminder":
    case "health_tip":
      return { type, route: "/patient/reminders" };
    case "medical_record_available":
    case "laboratory_result_available":
    case "prescription_available":
      return { type, route: "/patient/medical-records" };
    case "account_notification":
      return { type, route: "/patient/profile" };
    case "general":
    default:
      return { type: "general", route: "/patient/dashboard" };
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  const executionId = crypto.randomUUID();
  let acceptedNotificationId: string | null = null;

  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const expectedWebhookSecret = getRequiredEnvironment(
      "NATIVE_PUSH_WEBHOOK_SECRET",
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

    acceptedNotificationId = validateWebhookPayload(requestPayload);
    const supabaseUrl = getRequiredEnvironment("SUPABASE_URL");
    const supabase = createClient(supabaseUrl, getSupabaseAdminKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: notificationData, error: notificationError } = await supabase
      .from("patient_notifications")
      .select("id, patient_id, type")
      .eq("id", acceptedNotificationId)
      .maybeSingle();

    if (notificationError) throw new DatabaseFailure("load_notification");
    if (!notificationData) {
      return jsonResponse({
        ok: false,
        error: "notification_not_found",
        notificationId: acceptedNotificationId,
      }, 404);
    }

    const notification = notificationData as CanonicalNotificationRow;
    if (
      notification.id !== acceptedNotificationId ||
      !UUID_PATTERN.test(notification.patient_id) ||
      typeof notification.type !== "string"
    ) {
      throw new DatabaseFailure("validate_notification");
    }
    const metadata = getNativeNotificationMetadata(notification.type);

    const { data: deviceData, error: deviceError } = await supabase
      .from("patient_native_push_devices")
      .select("id, push_token, updated_at")
      .eq("patient_id", notification.patient_id)
      .eq("platform", "android")
      .eq("enabled", true);

    if (deviceError) throw new DatabaseFailure("load_devices");
    const devices = (deviceData ?? []) as NativeDeviceRow[];
    const summary: DeliverySummary = {
      ok: true,
      notificationId: notification.id,
      attempted: 0,
      sent: 0,
      failed: 0,
      disabledTokens: 0,
      skipped: 0,
    };

    console.info("Patient native push request accepted", {
      executionId,
      notificationId: notification.id,
      devices: devices.length,
    });

    if (devices.length === 0) {
      summary.reason = "no_active_devices";
      return jsonResponse(summary);
    }

    const firebaseAuthorization = await getFirebaseAuthorization();

    const deliverToDevice = async (
      device: NativeDeviceRow,
    ): Promise<DeliveryOutcome> => {
      if (
        !UUID_PATTERN.test(device.id) ||
        !device.push_token ||
        !device.updated_at
      ) {
        console.warn("Patient native push device row was invalid", {
          executionId,
          notificationId: notification.id,
          deviceId: UUID_PATTERN.test(device.id)
            ? device.id
            : "invalid_device_id",
        });
        return { attempted: false, result: "failed" };
      }

      const { data: claimData, error: claimError } = await supabase
        .from("patient_notification_native_push_deliveries")
        .insert({
          notification_id: notification.id,
          device_id: device.id,
          status: "processing",
          attempt_count: 1,
        })
        .select("id")
        .single();

      if (claimError) {
        if (isUniqueViolation(claimError)) {
          return { attempted: false, result: "skipped" };
        }
        console.error("Patient native push claim failed", {
          executionId,
          notificationId: notification.id,
          deviceId: device.id,
        });
        return { attempted: false, result: "failed" };
      }

      const claimId = typeof claimData?.id === "string" ? claimData.id : null;
      if (!claimId || !UUID_PATTERN.test(claimId)) {
        console.error("Patient native push claim result was invalid", {
          executionId,
          notificationId: notification.id,
          deviceId: device.id,
        });
        return { attempted: false, result: "failed" };
      }

      let sendResult: FirebaseSendResult;
      try {
        sendResult = await sendFirebaseMessage(firebaseAuthorization, {
          token: device.push_token,
          notificationId: notification.id,
          notificationType: metadata.type,
          route: metadata.route,
        });
      } catch {
        sendResult = {
          ok: false as const,
          httpStatus: null,
          errorCode: "FCM_OUTCOME_UNKNOWN",
          errorMessage:
            "FCM request failed before a response was received; delivery outcome is unknown.",
          permanentTokenFailure: false,
        };
      }

      if (sendResult.ok) {
        const { error: sentError } = await supabase
          .from("patient_notification_native_push_deliveries")
          .update({
            status: "sent",
            fcm_http_status: sendResult.httpStatus,
            error_code: null,
            error_message: null,
            provider_message_id: sendResult.providerMessageId,
            sent_at: new Date().toISOString(),
          })
          .eq("id", claimId);

        if (sentError) {
          console.error("Patient native push success recording failed", {
            executionId,
            notificationId: notification.id,
            deviceId: device.id,
          });
          return { attempted: true, result: "failed" };
        }
        return { attempted: true, result: "sent" };
      }

      let deliveryStatus: "failed" | "disabled_token" = "failed";
      let errorCode = sendResult.errorCode;
      let errorMessage = sendResult.errorMessage;

      if (sendResult.permanentTokenFailure) {
        const now = new Date().toISOString();
        const { data: disabledDevice, error: disableError } = await supabase
          .from("patient_native_push_devices")
          .update({ enabled: false, disabled_at: now, updated_at: now })
          .eq("id", device.id)
          .eq("updated_at", device.updated_at)
          .eq("enabled", true)
          .select("id")
          .maybeSingle();

        if (disableError || !disabledDevice) {
          errorCode = "DEVICE_DISABLE_FAILED";
          errorMessage = disableError
            ? "Invalid FCM token could not be disabled."
            : "Device registration changed before invalidation completed.";
        } else {
          deliveryStatus = "disabled_token";
        }
      }

      const { error: failureRecordError } = await supabase
        .from("patient_notification_native_push_deliveries")
        .update({
          status: deliveryStatus,
          fcm_http_status: sendResult.httpStatus,
          error_code: errorCode,
          error_message: errorMessage,
          provider_message_id: null,
          sent_at: null,
        })
        .eq("id", claimId);

      if (failureRecordError) {
        console.error("Patient native push failure recording failed", {
          executionId,
          notificationId: notification.id,
          deviceId: device.id,
        });
        return { attempted: true, result: "failed" };
      }

      console.warn("Patient native push delivery failed", {
        executionId,
        notificationId: notification.id,
        deviceId: device.id,
        status: sendResult.httpStatus,
        code: errorCode,
      });

      return { attempted: true, result: deliveryStatus };
    };

    for (let index = 0; index < devices.length; index += DEVICE_CONCURRENCY) {
      const chunk = devices.slice(index, index + DEVICE_CONCURRENCY);
      const outcomes = await Promise.allSettled(chunk.map(deliverToDevice));

      for (let offset = 0; offset < outcomes.length; offset += 1) {
        const outcome = outcomes[offset];
        if (outcome.status === "rejected") {
          summary.failed += 1;
          console.error("Patient native push device processing failed", {
            executionId,
            notificationId: notification.id,
            deviceId: chunk[offset].id,
          });
          continue;
        }

        if (outcome.value.attempted) summary.attempted += 1;
        if (outcome.value.result === "sent") summary.sent += 1;
        if (outcome.value.result === "failed") summary.failed += 1;
        if (outcome.value.result === "disabled_token") {
          summary.disabledTokens += 1;
        }
        if (outcome.value.result === "skipped") summary.skipped += 1;
      }
    }

    console.info("Patient native push request completed", {
      executionId,
      notificationId: notification.id,
      attempted: summary.attempted,
      sent: summary.sent,
      failed: summary.failed,
      disabledTokens: summary.disabledTokens,
      skipped: summary.skipped,
    });

    return jsonResponse(summary);
  } catch (error) {
    if (error instanceof RequestFailure) {
      return jsonResponse({ ok: false, error: error.publicCode }, error.status);
    }
    if (error instanceof FirebaseConfigurationError) {
      console.error("Patient native push Firebase authorization failed", {
        executionId,
        notificationId: acceptedNotificationId,
        status: error.httpStatus,
        code: error.publicCode,
      });
      return jsonResponse({
        ok: false,
        error: "firebase_authentication_failed",
        notificationId: acceptedNotificationId,
      }, 500);
    }
    if (error instanceof ServerConfigurationError) {
      return jsonResponse(
        { ok: false, error: "server_configuration_error" },
        500,
      );
    }
    if (error instanceof DatabaseFailure) {
      console.error("Patient native push database operation failed", {
        executionId,
        notificationId: acceptedNotificationId,
        operation: error.operation,
      });
    } else {
      console.error("Patient native push request failed", {
        executionId,
        notificationId: acceptedNotificationId,
        error: "internal_error",
      });
    }
    return jsonResponse({
      ok: false,
      error: "internal_error",
      notificationId: acceptedNotificationId,
    }, 500);
  }
});
