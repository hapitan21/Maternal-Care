export const SEMAPHORE_MESSAGES_ENDPOINT =
  "https://api.semaphore.co/api/v4/messages";

export type SemaphoreDispatchStatus = "sent" | "failed";

export type ParsedSemaphoreResponse = {
  messageId: string;
  providerStatus: string;
  dispatchStatus: SemaphoreDispatchStatus;
};

type JsonObject = Record<string, unknown>;

export class SemaphoreResponseError extends Error {
  publicCode: string;

  constructor(publicCode: string) {
    super(publicCode);
    this.name = "SemaphoreResponseError";
    this.publicCode = publicCode;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizePhilippinePhoneNumber(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;

  const compact = value.trim().replace(/[\s().-]/g, "");

  if (/^\+639\d{9}$/.test(compact)) return compact.slice(1);
  if (/^639\d{9}$/.test(compact)) return compact;
  if (/^09\d{9}$/.test(compact)) return `63${compact.slice(1)}`;
  if (/^9\d{9}$/.test(compact)) return `63${compact}`;

  return null;
}

export function maskPhoneNumber(normalizedPhone: string): string {
  if (!/^639\d{9}$/.test(normalizedPhone)) return "invalid-number";

  const localPhone = `0${normalizedPhone.slice(2)}`;
  return `${localPhone.slice(0, 2)}*****${localPhone.slice(-4)}`;
}

export function normalizeSemaphoreStatus(
  value: unknown,
): SemaphoreDispatchStatus | null {
  if (typeof value !== "string") return null;

  switch (value.trim().toLowerCase()) {
    case "queued":
    case "pending":
    case "sent":
      return "sent";
    case "failed":
    case "refunded":
      return "failed";
    default:
      return null;
  }
}

export function parseSemaphoreResponse(
  payload: unknown,
): ParsedSemaphoreResponse {
  if (!Array.isArray(payload) || payload.length < 1 || !isJsonObject(payload[0])) {
    throw new SemaphoreResponseError("semaphore_invalid_response");
  }

  const record = payload[0];
  const rawMessageId = record.message_id;
  const messageId = typeof rawMessageId === "number" &&
      Number.isSafeInteger(rawMessageId) && rawMessageId > 0
    ? String(rawMessageId)
    : typeof rawMessageId === "string"
    ? rawMessageId.trim()
    : "";

  if (!/^\d{1,255}$/.test(messageId)) {
    throw new SemaphoreResponseError("semaphore_missing_message_id");
  }

  if (typeof record.status !== "string" || !record.status.trim()) {
    throw new SemaphoreResponseError("semaphore_missing_status");
  }

  const dispatchStatus = normalizeSemaphoreStatus(record.status);
  if (!dispatchStatus) {
    throw new SemaphoreResponseError("semaphore_unknown_status");
  }

  return {
    messageId,
    providerStatus: record.status.trim().toLowerCase(),
    dispatchStatus,
  };
}
