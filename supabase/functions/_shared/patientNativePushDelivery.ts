import type { FirebaseAuthorization, FirebaseMessage, FirebaseSendResult } from "./firebaseMessaging.ts";

export type DeliveryClaim = {
  delivery_id: string;
  claim_token: string;
  attempt_count: number;
};
export type Finalization = { result: "finalized" | "already_finalized" | "stale_claim"; status: string | null };
export type FinalizationArguments = {
  p_delivery_id: string; p_claim_token: string; p_attempt_count: number;
  p_failure_class: string; p_http_status: number | null; p_error_code: string | null;
  p_provider_message_id: string | null; p_device_updated_at: string;
  p_retry_after_ms: number | null;
};
export interface NativeDeliveryStore {
  claim(notificationId: string, deviceId: string, mode: "notification" | "retry"):
    Promise<{ data: DeliveryClaim | null; error: unknown }>;
  finalize(args: FinalizationArguments): Promise<{ data: Finalization | null; error: unknown }>;
}
export type DeliveryOutcome = {
  attempted: boolean;
  result: "sent" | "failed" | "disabled_token" | "skipped";
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINALIZATION_DELAYS_MS = [0, 250, 1000, 2000];
function retryableRecordingFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const failure = error as { code?: string; status?: number };
  if (failure.status && failure.status >= 400 && failure.status < 500) return false;
  return !failure.code || /^(?:08|40001$|40P01$|53300$|57P0[123]$|PGRST00[012]$)/.test(failure.code);
}

// Shared by webhook and retry tick. A claimed provider request is sent ONCE only.
export async function deliverPatientNativePushDevice(options: {
  store: NativeDeliveryStore;
  send: (authorization: FirebaseAuthorization, message: FirebaseMessage) => Promise<FirebaseSendResult>;
  authorization: FirebaseAuthorization;
  notification: { id: string; type: string; route: string };
  device: { id: string; push_token: string; updated_at: string };
  mode: "notification" | "retry";
  log?: (event: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<DeliveryOutcome> {
  const { store, device, notification } = options;
  if (!UUID.test(device.id) || !device.push_token || !device.updated_at) {
    return { attempted: false, result: "failed" };
  }
  let claim: DeliveryClaim | null;
  try {
    const response = await store.claim(notification.id, device.id, options.mode);
    if (response.error) throw response.error;
    claim = response.data;
  } catch {
    options.log?.("claim_failed");
    return { attempted: false, result: "failed" };
  }
  if (!claim) return { attempted: false, result: "skipped" };
  if (!UUID.test(claim.delivery_id) || !UUID.test(claim.claim_token)
      || !Number.isInteger(claim.attempt_count) || claim.attempt_count < 1 || claim.attempt_count > 4) {
    options.log?.("claim_result_invalid");
    return { attempted: false, result: "failed" };
  }
  let provider: FirebaseSendResult;
  try {
    provider = await options.send(options.authorization, {
      token: device.push_token, notificationId: notification.id,
      notificationType: notification.type, route: notification.route,
    });
  } catch {
    provider = { ok: false, httpStatus: null, permanentTokenFailure: false,
      failureClass: "unknown_outcome", retryAfterMs: null,
      errorCode: "FCM_OUTCOME_UNKNOWN", errorMessage: "FCM delivery outcome is unknown." };
  }
  const args: FinalizationArguments = Object.freeze({
    p_delivery_id: claim.delivery_id, p_claim_token: claim.claim_token,
    p_attempt_count: claim.attempt_count,
    p_failure_class: provider.ok ? "success" : provider.failureClass,
    p_http_status: provider.httpStatus,
    p_error_code: provider.ok ? null : provider.errorCode,
    p_provider_message_id: provider.ok ? provider.providerMessageId : null,
    p_device_updated_at: device.updated_at,
    p_retry_after_ms: provider.ok ? null : provider.retryAfterMs,
  });
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  // Same immutable provider outcome/claim on every recording retry; never call send again.
  for (const delay of FINALIZATION_DELAYS_MS) {
    if (delay) await wait(delay);
    try {
      const response = await store.finalize(args);
      if (response.error) throw response.error;
      if (response.data?.result === "stale_claim") {
        options.log?.("finalization_stale");
        return { attempted: true, result: "skipped" };
      }
      if (response.data?.result === "already_finalized" && response.data.status === "delivery_unknown") {
        options.log?.("delivery_unknown_acknowledged");
        return { attempted: true, result: "skipped" };
      }
      if (["finalized", "already_finalized"].includes(response.data?.result || "")
          && ["sent", "failed", "disabled_token"].includes(response.data?.status || "")) {
        return { attempted: true, result: response.data!.status as DeliveryOutcome["result"] };
      }
      break;
    } catch (error) {
      if (!retryableRecordingFailure(error)) break;
    }
  }
  options.log?.("finalization_exhausted");
  return { attempted: true, result: "failed" };
}
