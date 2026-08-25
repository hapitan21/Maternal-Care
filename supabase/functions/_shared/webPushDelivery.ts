// web-push 3.6.7 is a CommonJS package without bundled TypeScript declarations.
// @ts-ignore Deno's npm compatibility layer provides the runtime module.
import webPush from "npm:web-push@3.6.7";

export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  authKey: string;
};

type JsonObject = Record<string, unknown>;

type PushErrorShape = {
  statusCode?: unknown;
};

export class WebPushConfigurationError extends Error {
  constructor() {
    super("server_configuration_error");
    this.name = "WebPushConfigurationError";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function timingSafeEqual(
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

export function getRequiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new WebPushConfigurationError();
  return value;
}

export function getSupabaseAdminKey(): string {
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();

  if (secretKeysJson) {
    try {
      const parsed = JSON.parse(secretKeysJson);
      if (
        isJsonObject(parsed) &&
        typeof parsed.default === "string" &&
        parsed.default.trim()
      ) {
        return parsed.default.trim();
      }
    } catch {
      throw new WebPushConfigurationError();
    }

    throw new WebPushConfigurationError();
  }

  const localSecretKey = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (localSecretKey) return localSecretKey;
  return getRequiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
}

function isValidVapidSubject(subject: string): boolean {
  try {
    const parsed = new URL(subject);
    return (
      (parsed.protocol === "mailto:" && parsed.pathname.includes("@")) ||
      parsed.protocol === "https:"
    );
  } catch {
    return false;
  }
}

export function configureWebPushFromEnvironment(): void {
  const publicKey = getRequiredEnvironment("WEB_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = getRequiredEnvironment("WEB_PUSH_VAPID_PRIVATE_KEY");
  const subject = getRequiredEnvironment("WEB_PUSH_VAPID_SUBJECT");

  if (!isValidVapidSubject(subject)) throw new WebPushConfigurationError();

  try {
    webPush.setVapidDetails(subject, publicKey, privateKey);
  } catch {
    throw new WebPushConfigurationError();
  }
}

export function getPushStatus(error: unknown): number | null {
  if (!isJsonObject(error)) return null;

  const statusCode = (error as PushErrorShape).statusCode;
  return typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
    ? statusCode
    : null;
}

export function getSafePushFailure(status: number | null): {
  code: string;
  message: string;
} {
  if (status === 404 || status === 410) {
    return {
      code: "subscription_expired",
      message: "Push subscription is no longer valid.",
    };
  }
  if (status === 429) {
    return {
      code: "push_rate_limited",
      message: "Push service temporarily rate limited delivery.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      code: "push_service_unavailable",
      message: "Push service is temporarily unavailable.",
    };
  }
  if (status !== null) {
    return {
      code: "push_service_rejected",
      message: "Push service rejected the notification.",
    };
  }
  return {
    code: "push_delivery_failed",
    message: "Web Push delivery failed.",
  };
}

export function isUniqueViolation(error: unknown): boolean {
  return isJsonObject(error) && error.code === "23505";
}

export async function sendWebPushNotification(
  subscription: PushSubscriptionKeys,
  payload: string,
  urgency: "normal" | "high",
): Promise<number | null> {
  const result = await webPush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.authKey,
      },
    },
    payload,
    {
      TTL: 24 * 60 * 60,
      timeout: 10_000,
      urgency,
      contentEncoding: "aes128gcm",
    },
  );

  return typeof result?.statusCode === "number" ? result.statusCode : null;
}
