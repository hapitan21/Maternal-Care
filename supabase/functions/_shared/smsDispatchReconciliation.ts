export const DEFAULT_SMS_RETRY_STALE_MS = 30 * 60 * 1000;
export const MINIMUM_SMS_RETRY_STALE_MS = 30 * 60 * 1000;

export type SmsDispatchReconciliationClassification =
  | "safe_retry_candidate"
  | "manual_review_transport_started"
  | "terminal_success"
  | "terminal_cancelled"
  | "recent_processing"
  | "recent_failed"
  | "failed_requires_review"
  | "pending_requires_review"
  | "unsupported_state";

export type SmsDispatchRecoveryRow = {
  id: string;
  dispatch_key: string;
  channel: string;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  attempt_count: number;
  processing_started_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
  last_error: string | null;
};

type RetryStoreResult = {
  data: SmsDispatchRecoveryRow | null;
  error: unknown | null;
};

export type SmsDispatchRetryStore = {
  tryClaim: (request: {
    dispatchId: string;
    expectedDispatchKey: string;
    staleBefore: string;
    attemptedAt: string;
  }) => Promise<RetryStoreResult>;
  load: (dispatchId: string) => Promise<RetryStoreResult>;
};

export class SmsDispatchRetryError extends Error {
  operation: "claim_retry" | "reload_dispatch";

  constructor(operation: "claim_retry" | "reload_dispatch") {
    super("database_error");
    this.name = "SmsDispatchRetryError";
    this.operation = operation;
  }
}

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function parseTimestamp(value: unknown): number | null {
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function classifySmsDispatch(
  dispatch: SmsDispatchRecoveryRow,
  now = new Date(),
  staleAfterMs = DEFAULT_SMS_RETRY_STALE_MS,
): SmsDispatchReconciliationClassification {
  const status = normalize(dispatch.status);
  const provider = normalize(dispatch.provider);
  const staleBefore = now.getTime() - staleAfterMs;

  if (status === "sent" || status === "delivered") {
    return "terminal_success";
  }
  if (status === "cancelled") {
    return "terminal_cancelled";
  }

  if (status === "processing") {
    if (provider) return "manual_review_transport_started";
    if (
      dispatch.provider_message_id ||
      dispatch.sent_at ||
      dispatch.delivered_at
    ) {
      return "failed_requires_review";
    }
    if (dispatch.failed_at) return "failed_requires_review";

    const processingStartedAt = parseTimestamp(dispatch.processing_started_at);
    if (processingStartedAt === null) return "failed_requires_review";
    return processingStartedAt <= staleBefore
      ? "safe_retry_candidate"
      : "recent_processing";
  }

  if (status === "failed") {
    if (provider) return "failed_requires_review";
    if (
      dispatch.provider_message_id ||
      dispatch.sent_at ||
      dispatch.delivered_at
    ) {
      return "failed_requires_review";
    }

    const failedAt = parseTimestamp(dispatch.failed_at);
    if (failedAt === null) return "failed_requires_review";
    return failedAt <= staleBefore
      ? "safe_retry_candidate"
      : "recent_failed";
  }

  if (status === "pending") return "pending_requires_review";
  return "unsupported_state";
}

export async function claimSmsDispatchRetry(
  store: SmsDispatchRetryStore,
  dispatchId: string,
  expectedDispatchKey: string,
  now = new Date(),
  staleAfterMs = DEFAULT_SMS_RETRY_STALE_MS,
) {
  if (staleAfterMs < MINIMUM_SMS_RETRY_STALE_MS) {
    throw new RangeError("retry_stale_threshold_too_short");
  }

  const attemptedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();
  const claimed = await store.tryClaim({
    dispatchId,
    expectedDispatchKey,
    staleBefore,
    attemptedAt,
  });

  if (claimed.error) throw new SmsDispatchRetryError("claim_retry");
  if (claimed.data) {
    return {
      dispatch: claimed.data,
      retryClaimed: true,
      maySend: true,
      classification: "retry_claimed" as const,
    };
  }

  const current = await store.load(dispatchId);
  if (current.error) throw new SmsDispatchRetryError("reload_dispatch");
  if (!current.data) {
    return {
      dispatch: null,
      retryClaimed: false,
      maySend: false,
      classification: "not_found" as const,
    };
  }

  if (current.data.dispatch_key !== expectedDispatchKey) {
    return {
      dispatch: current.data,
      retryClaimed: false,
      maySend: false,
      classification: "dispatch_key_mismatch" as const,
    };
  }

  return {
    dispatch: current.data,
    retryClaimed: false,
    maySend: false,
    classification: classifySmsDispatch(current.data, now, staleAfterMs),
  };
}
