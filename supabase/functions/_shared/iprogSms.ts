export const IPROGSMS_MESSAGES_ENDPOINT =
  "https://www.iprogsms.com/api/v1/sms_messages";
export const IPROGSMS_PROVIDER = "iprogsms";

export type AcceptedSmsResult = {
  messageId: string;
  providerStatus: "queued";
  // Ledger "sent" means provider acceptance, never confirmed handset delivery.
  dispatchStatus: "sent";
};

export class IprogSmsError extends Error {
  constructor(public readonly publicCode: string) {
    super(publicCode);
    this.name = "IprogSmsError";
  }
}

export function parseIprogSmsResponse(payload: unknown): AcceptedSmsResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new IprogSmsError("iprogsms_invalid_response");
  }
  const record = payload as Record<string, unknown>;
  if (record.status !== 200) throw new IprogSmsError("iprogsms_rejected");

  const messageId = typeof record.message_id === "string"
    ? record.message_id.trim()
    : "";
  // Accept opaque IDs such as iSms-abc123, but reject URLs/control characters.
  if (!/^[a-z0-9][a-z0-9._-]{0,254}$/i.test(messageId)) {
    throw new IprogSmsError("iprogsms_missing_message_id");
  }

  // Explicit allowlist: never copy message_status_link (may contain api_token),
  // raw message text, sms_rate, or any other provider response property.
  return { messageId, providerStatus: "queued", dispatchStatus: "sent" };
}

type SmsDependencies = {
  readEnvironment?: (name: string) => string | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export async function sendIprogSms(
  input: { phoneNumber: string; message: string },
  dependencies: SmsDependencies = {},
): Promise<AcceptedSmsResult> {
  const readEnvironment = dependencies.readEnvironment ??
    ((name: string) => Deno.env.get(name));
  const apiToken = readEnvironment("IPROGSMS_API_TOKEN")?.trim();
  if (!apiToken) throw new IprogSmsError("iprogsms_missing_api_token");
  if (!/^639\d{9}$/.test(input.phoneNumber)) {
    throw new IprogSmsError("patient_phone_invalid");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ?? 12_000,
  );
  try {
    let response: Response;
    try {
      response = await (dependencies.fetch ?? globalThis.fetch)(
        IPROGSMS_MESSAGES_ENDPOINT,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_token: apiToken,
            phone_number: input.phoneNumber,
            message: input.message,
          }),
          signal: controller.signal,
        },
      );
    } catch {
      throw new IprogSmsError(
        controller.signal.aborted
          ? "iprogsms_timeout"
          : "iprogsms_network_error",
      );
    }
    if (!response.ok) {
      throw new IprogSmsError(`iprogsms_http_${response.status}`);
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      throw new IprogSmsError(
        controller.signal.aborted
          ? "iprogsms_timeout"
          : "iprogsms_response_read_failed",
      );
    }
    if (controller.signal.aborted) throw new IprogSmsError("iprogsms_timeout");
    if (!responseText || responseText.length > 100_000) {
      throw new IprogSmsError("iprogsms_invalid_response");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new IprogSmsError("iprogsms_invalid_json");
    }
    return parseIprogSmsResponse(payload);
  } finally {
    // Covers response-body consumption too. Never retry an ambiguous submission.
    clearTimeout(timeoutId);
  }
}
