import { createClient } from "@supabase/supabase-js";
import {
  FirebaseConfigurationError,
  getFirebaseAuthorization,
  sendFirebaseMessage,
} from "../_shared/firebaseMessaging.ts";

import { deliverPatientNativePushDevice, type DeliveryOutcome, type NativeDeliveryStore } from "../_shared/patientNativePushDelivery.ts";

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

type DeliverySummary = {
  ok: true;
  notificationId?: string;
  mode?: "retry";
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
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const mode = request.headers.get("x-native-push-mode") === "retry" ? "retry" : "notification";
    const expected = getRequiredEnvironment(mode === "retry" ? "NATIVE_PUSH_RETRY_SECRET" : "NATIVE_PUSH_WEBHOOK_SECRET");
    const other = Deno.env.get(mode === "retry" ? "NATIVE_PUSH_WEBHOOK_SECRET" : "NATIVE_PUSH_RETRY_SECRET")?.trim();
    if (expected === other || (mode === "retry" && !/^[A-Za-z0-9_-]{32,256}$/.test(expected))) {
      throw new ServerConfigurationError();
    }
    const supplied = request.headers.get(mode === "retry" ? "x-retry-secret" : "x-webhook-secret");
    if (!supplied || !(await timingSafeEqual(supplied, expected))) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }
    let payload: unknown;
    try { payload = await request.json(); } catch { throw new RequestFailure(400, "invalid_json"); }
    if (mode === "retry") {
      if (!isJsonObject(payload) || payload.mode !== "retry" || Object.keys(payload).length !== 1) {
        throw new RequestFailure(400, "invalid_retry_request");
      }
    } else {
      acceptedNotificationId = validateWebhookPayload(payload);
    }
    // No operational database access happens before mode-specific authentication.
    const supabase = createClient(getRequiredEnvironment("SUPABASE_URL"), getSupabaseAdminKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signal = () => AbortSignal.timeout(5000);
    const store: NativeDeliveryStore = {
      async claim(notificationId, deviceId, claimMode) {
        return await supabase.rpc("claim_patient_native_push_delivery", {
          p_notification_id: notificationId, p_device_id: deviceId, p_mode: claimMode,
        }).abortSignal(signal()).maybeSingle();
      },
      async finalize(args) {
        return await supabase.rpc("finalize_patient_native_push_delivery", args)
          .abortSignal(signal()).maybeSingle();
      },
    };
    const loadNotification = async (id: string): Promise<CanonicalNotificationRow | null> => {
      const response = await supabase.from("patient_notifications").select("id, patient_id, type")
        .eq("id", id).abortSignal(signal()).maybeSingle();
      if (response.error) throw new DatabaseFailure("load_notification");
      if (!response.data) return null;
      const row = response.data as CanonicalNotificationRow;
      if (row.id !== id || !UUID_PATTERN.test(row.patient_id) || typeof row.type !== "string") {
        throw new DatabaseFailure("validate_notification");
      }
      return row;
    };
    const summary: DeliverySummary = {
      ok: true, attempted: 0, sent: 0, failed: 0, disabledTokens: 0, skipped: 0,
      ...(mode === "retry" ? { mode: "retry" as const } : { notificationId: acceptedNotificationId! }),
    };
    let tasks: Array<() => Promise<DeliveryOutcome>> = [];
    let authorization: Awaited<ReturnType<typeof getFirebaseAuthorization>>;
    const deliver = (notification: CanonicalNotificationRow, device: NativeDeviceRow) => {
      const metadata = getNativeNotificationMetadata(notification.type);
      return deliverPatientNativePushDevice({ store, authorization, send: sendFirebaseMessage,
        notification: { id: notification.id, type: metadata.type, route: metadata.route }, device, mode,
        // Never include claim tokens, registration values, provider bodies or exception objects.
        log: event => console.warn("Patient native push operational outcome", { executionId, event }),
      });
    };
    if (mode === "notification") {
      const notification = await loadNotification(acceptedNotificationId!);
      if (!notification) return jsonResponse({ ok: false, error: "notification_not_found", notificationId: acceptedNotificationId }, 404);
      const response = await supabase.from("patient_native_push_devices").select("id, push_token, updated_at")
        .eq("patient_id", notification.patient_id).eq("platform", "android").eq("enabled", true)
        .abortSignal(signal());
      if (response.error) throw new DatabaseFailure("load_devices");
      tasks = ((response.data ?? []) as NativeDeviceRow[]).map(device => () => deliver(notification, device));
      if (!tasks.length) { summary.reason = "no_active_devices"; return jsonResponse(summary); }
    } else {
      // DB discovery applies canonical/enabled/window/due filters, ordering and LIMIT 10.
      const response = await supabase.rpc("list_due_patient_native_push_deliveries").abortSignal(signal());
      if (response.error) throw new DatabaseFailure("list_due_deliveries");
      const candidates = response.data as Array<{ notification_id: string; device_id: string }> | null;
      tasks = (candidates ?? []).slice(0, 10).map(candidate => async () => {
        if (!UUID_PATTERN.test(candidate.notification_id) || !UUID_PATTERN.test(candidate.device_id)) {
          return { attempted: false, result: "failed" };
        }
        const notification = await loadNotification(candidate.notification_id);
        if (!notification) return { attempted: false, result: "skipped" };
        const selected = await supabase.from("patient_native_push_devices").select("id, push_token, updated_at")
          .eq("id", candidate.device_id).eq("patient_id", notification.patient_id)
          .eq("platform", "android").eq("enabled", true).abortSignal(signal()).maybeSingle();
        if (selected.error) throw new DatabaseFailure("load_retry_device");
        if (!selected.data) return { attempted: false, result: "skipped" };
        return deliver(notification, selected.data as NativeDeviceRow);
      });
      if (!tasks.length) return jsonResponse(summary);
    }
    authorization = await getFirebaseAuthorization();
    for (let index = 0; index < tasks.length; index += DEVICE_CONCURRENCY) {
      const outcomes = await Promise.allSettled(tasks.slice(index, index + DEVICE_CONCURRENCY).map(task => task()));
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") { summary.failed++; continue; }
        if (outcome.value.attempted) summary.attempted++;
        if (outcome.value.result === "sent") summary.sent++;
        if (outcome.value.result === "failed") summary.failed++;
        if (outcome.value.result === "disabled_token") summary.disabledTokens++;
        if (outcome.value.result === "skipped") summary.skipped++;
      }
    }
    console.info("Patient native push request completed", {
      executionId, mode, attempted: summary.attempted, sent: summary.sent,
      failed: summary.failed, disabledTokens: summary.disabledTokens, skipped: summary.skipped,
    });
    return jsonResponse(summary);
  } catch (error) {
    if (error instanceof RequestFailure) return jsonResponse({ ok: false, error: error.publicCode }, error.status);
    if (error instanceof FirebaseConfigurationError) {
      console.error("Patient native push Firebase authorization failed", { executionId, code: error.publicCode });
      return jsonResponse({ ok: false, error: "firebase_authentication_failed", notificationId: acceptedNotificationId }, 500);
    }
    if (error instanceof ServerConfigurationError) return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    console.error("Patient native push request failed", {
      executionId, operation: error instanceof DatabaseFailure ? error.operation : "internal_error",
    });
    return jsonResponse({ ok: false, error: "internal_error", notificationId: acceptedNotificationId }, 500);
  }
});
