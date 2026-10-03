const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FIREBASE_MESSAGING_SCOPE =
  "https://www.googleapis.com/auth/firebase.messaging";
const FCM_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const SAFE_ERROR_CODE_PATTERN = /[^A-Z0-9_:-]/g;

type JsonObject = Record<string, unknown>;

type ServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
};

type CachedAccessToken = {
  accessToken: string;
  expiresAt: number;
  projectId: string;
};

export type FirebaseAuthorization = {
  accessToken: string;
  projectId: string;
};

export type FirebaseMessage = {
  token: string;
  notificationId: string;
  notificationType: string;
  route: string;
};

export type FirebaseFailureClass = "permanent_device" | "confirmed_transient" | "non_retryable" | "unknown_outcome";

export type FirebaseSendResult =
  | {
    ok: true;
    httpStatus: number;
    providerMessageId: string | null;
  }
  | {
    ok: false;
    httpStatus: number | null;
    errorCode: string;
    errorMessage: string;
    permanentTokenFailure: boolean;
    failureClass: FirebaseFailureClass;
    retryAfterMs: number | null;
  };

export class FirebaseConfigurationError extends Error {
  publicCode: string;
  httpStatus: number | null;

  constructor(publicCode: string, httpStatus: number | null = null) {
    super("firebase_configuration_error");
    this.name = "FirebaseConfigurationError";
    this.publicCode = publicCode;
    this.httpStatus = httpStatus;
  }
}

let cachedAccessToken: CachedAccessToken | null = null;
let accessTokenInFlight: Promise<FirebaseAuthorization> | null = null;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRequiredString(
  value: unknown,
  field: "project_id" | "client_email" | "private_key",
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FirebaseConfigurationError(`invalid_${field}`);
  }
  return value.trim();
}

function parseServiceAccount(): ServiceAccount {
  const rawServiceAccount = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    ?.trim();
  if (!rawServiceAccount) {
    throw new FirebaseConfigurationError("missing_service_account");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawServiceAccount);
  } catch {
    throw new FirebaseConfigurationError("invalid_service_account_json");
  }

  if (!isJsonObject(parsed)) {
    throw new FirebaseConfigurationError("invalid_service_account_json");
  }

  const projectId = getRequiredString(parsed.project_id, "project_id");
  const clientEmail = getRequiredString(parsed.client_email, "client_email");
  const privateKey = getRequiredString(parsed.private_key, "private_key");
  const privateKeyId = typeof parsed.private_key_id === "string" &&
      parsed.private_key_id.trim()
    ? parsed.private_key_id.trim()
    : null;

  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new FirebaseConfigurationError("invalid_project_id");
  }
  if (
    clientEmail.length > 320 ||
    !clientEmail.includes("@") ||
    /[\r\n]/.test(clientEmail)
  ) {
    throw new FirebaseConfigurationError("invalid_client_email");
  }
  if (
    !privateKey.includes("-----BEGIN PRIVATE KEY-----") ||
    !privateKey.includes("-----END PRIVATE KEY-----")
  ) {
    throw new FirebaseConfigurationError("invalid_private_key");
  }
  if (privateKeyId && privateKeyId.length > 256) {
    throw new FirebaseConfigurationError("invalid_private_key_id");
  }

  return { projectId, clientEmail, privateKey, privateKeyId };
}

function encodeBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodePrivateKey(privateKey: string): ArrayBuffer {
  const base64 = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    throw new FirebaseConfigurationError("invalid_private_key");
  }
}

async function createServiceAccountAssertion(
  serviceAccount: ServiceAccount,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header: JsonObject = { alg: "RS256", typ: "JWT" };
  if (serviceAccount.privateKeyId) header.kid = serviceAccount.privateKeyId;

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedClaims = encodeBase64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: FIREBASE_MESSAGING_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const unsignedAssertion = `${encodedHeader}.${encodedClaims}`;

  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      decodePrivateKey(serviceAccount.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof FirebaseConfigurationError) throw error;
    throw new FirebaseConfigurationError("invalid_private_key");
  }

  let signature: ArrayBuffer;
  try {
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKey,
      new TextEncoder().encode(unsignedAssertion),
    );
  } catch {
    throw new FirebaseConfigurationError("jwt_signing_failed");
  }

  return `${unsignedAssertion}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  let response: Response | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("request_deadline"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        response = await fetch(input, { ...init, signal: controller.signal });
        let payload: unknown = null;
        try { payload = await response.json(); } catch { /* Never retain raw responses. */ }
        return { response, payload };
      })(),
      deadline,
    ]);
  } catch (error) {
    // Known HTTP acceptance/rejection survives a body timeout; ambiguous 5xx will be E.
    if (response) return { response, payload: null };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAccessToken(
  serviceAccount: ServiceAccount,
): Promise<FirebaseAuthorization> {
  const assertion = await createServiceAccountAssertion(serviceAccount);
  let response: Response;
  let payload: unknown;

  try {
    ({ response, payload } = await fetchWithTimeout(
      GOOGLE_OAUTH_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      },
      OAUTH_REQUEST_TIMEOUT_MS,
    ));
  } catch {
    throw new FirebaseConfigurationError("oauth_network_error");
  }

  if (!response.ok || !isJsonObject(payload)) {
    throw new FirebaseConfigurationError(
      "oauth_request_failed",
      response.status,
    );
  }

  const accessToken = typeof payload.access_token === "string"
    ? payload.access_token.trim()
    : "";
  const expiresIn = typeof payload.expires_in === "number"
    ? payload.expires_in
    : Number(payload.expires_in);

  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 60) {
    throw new FirebaseConfigurationError(
      "invalid_oauth_response",
      response.status,
    );
  }

  cachedAccessToken = {
    accessToken,
    expiresAt: Date.now() + Math.floor(expiresIn * 1000),
    projectId: serviceAccount.projectId,
  };

  return { accessToken, projectId: serviceAccount.projectId };
}

export async function getFirebaseAuthorization(): Promise<
  FirebaseAuthorization
> {
  const serviceAccount = parseServiceAccount();

  if (
    cachedAccessToken &&
    cachedAccessToken.projectId === serviceAccount.projectId &&
    cachedAccessToken.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()
  ) {
    return {
      accessToken: cachedAccessToken.accessToken,
      projectId: cachedAccessToken.projectId,
    };
  }

  if (!accessTokenInFlight) {
    accessTokenInFlight = requestAccessToken(serviceAccount).finally(() => {
      accessTokenInFlight = null;
    });
  }

  return await accessTokenInFlight;
}

function getFcmErrorDetails(payload: unknown): {
  status: string | null;
  errorCode: string | null;
  invalidTokenField: boolean;
  invalidTokenFcmError: boolean;
} {
  if (!isJsonObject(payload) || !isJsonObject(payload.error)) {
    return { status: null, errorCode: null, invalidTokenField: false, invalidTokenFcmError: false };
  }

  const error = payload.error;
  const status = typeof error.status === "string" ? error.status : null;
  const details = Array.isArray(error.details) ? error.details : [];
  let errorCode: string | null = null;
  let invalidTokenField = false;

  for (const detail of details) {
    if (!isJsonObject(detail)) continue;

    if (
      detail["@type"] ===
        "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
      typeof detail.errorCode === "string"
    ) {
      errorCode = detail.errorCode;
    }

    if (
      detail["@type"] === "type.googleapis.com/google.rpc.BadRequest" &&
      Array.isArray(detail.fieldViolations)
    ) {
      for (const violation of detail.fieldViolations) {
        if (!isJsonObject(violation) || violation.field !== "message.token") {
          continue;
        }
        const description = typeof violation.description === "string"
          ? violation.description.toLowerCase()
          : "";
        if (
          description.includes("registration token") &&
          (description.includes("invalid") || description.includes("not valid"))
        ) {
          invalidTokenField = true;
        }
      }
    }
  }

  // FcmError.INVALID_ARGUMENT is ambiguous. Recognize only Firebase's documented
  // invalid-registration response, with no conflicting BadRequest payload detail.
  // https://firebase.google.com/docs/cloud-messaging/error-codes
  const invalidTokenFcmError = errorCode === "INVALID_ARGUMENT" &&
    status === "INVALID_ARGUMENT" &&
    error.message === "The registration token is not a valid FCM registration token" &&
    !details.some((detail) =>
      isJsonObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.BadRequest"
    );

  return { status, errorCode, invalidTokenField, invalidTokenFcmError };
}

function sanitizeErrorCode(value: string | null, httpStatus: number): string {
  const normalized = (value || `HTTP_${httpStatus}`)
    .toUpperCase()
    .replace(SAFE_ERROR_CODE_PATTERN, "_")
    .slice(0, 80);
  return normalized || "FCM_REQUEST_FAILED";
}

function getSafeErrorMessage(
  errorCode: string,
  httpStatus: number,
  permanentTokenFailure: boolean,
): string {
  if (permanentTokenFailure) {
    return "FCM registration token is no longer valid.";
  }
  if (httpStatus === 429 || errorCode === "QUOTA_EXCEEDED") {
    return "FCM temporarily rate limited delivery.";
  }
  if (httpStatus === 500 || errorCode === "INTERNAL") {
    return "FCM reported a temporary internal error.";
  }
  if (httpStatus === 503 || errorCode === "UNAVAILABLE") {
    return "FCM is temporarily unavailable.";
  }
  if (httpStatus === 401) return "FCM authentication failed.";
  if (httpStatus === 403 || errorCode === "SENDER_ID_MISMATCH") {
    return "FCM rejected the sender configuration.";
  }
  if (httpStatus === 400 || errorCode === "INVALID_ARGUMENT") {
    return "FCM rejected the message request.";
  }
  return "FCM delivery failed.";
}

// A delay >= the retry window is a terminal scheduling sentinel, never an earlier retry.
const RETRY_WINDOW_MS = 30 * 60 * 1000;
function delayMilliseconds(value: string): number | null {
  if (!/^\d+(?:\.\d{1,9})?$/.test(value)) return null;
  const seconds = Number(value);
  return seconds >= RETRY_WINDOW_MS / 1000 ? RETRY_WINDOW_MS
    : Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}
const HTTP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HTTP_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HTTP_LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// RFC 9110 section 5.6.7: parse all three HTTP-date forms without Date.parse.
// Unrelated locale formats, rolled-over dates and inconsistent weekdays are rejected.
function httpDateMilliseconds(value: string, now: number): number | null {
  const imf = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  const match = imf || rfc850 || asctime;
  if (!match) return null;

  const weekday = (rfc850 ? HTTP_LONG_DAYS : HTTP_DAYS).indexOf(match[1]);
  const day = Number(asctime ? match[3] : match[2]);
  const month = HTTP_MONTHS.indexOf(asctime ? match[2] : match[3]);
  let year = Number(asctime ? match[7] : match[4]);
  const hour = Number(asctime ? match[4] : match[5]);
  const minute = Number(asctime ? match[5] : match[6]);
  const second = Number(asctime ? match[6] : match[7]);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;

  const date = new Date(0);
  if (rfc850) {
    const currentYear = new Date(now).getUTCFullYear();
    year += Math.floor(currentYear / 100) * 100;
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, Math.min(second, 59), 0);
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(currentYear + 50);
    if (date.getTime() + (second === 60 ? 1000 : 0) > cutoff.getTime()) year -= 100;
  }
  if (year < 1 || year > 9999) return null;
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month ||
      date.getUTCDate() !== day || date.getUTCDay() !== weekday) return null;
  // HTTP-date permits a leap second; normalize it to the next second.
  return date.getTime() + (second === 60 ? 1000 : 0);
}

function getRetryAfterMs(response: Response, payload: unknown): number | null {
  const delays: number[] = [];
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    if (/^\d+$/.test(header)) {
      const delay = delayMilliseconds(header);
      if (delay !== null) delays.push(delay);
    } else {
      const now = Date.now();
      const date = httpDateMilliseconds(header, now);
      if (date !== null) delays.push(Math.min(RETRY_WINDOW_MS, Math.max(0, date - now)));
    }
  }
  if (isJsonObject(payload) && isJsonObject(payload.error) && Array.isArray(payload.error.details)) {
    for (const detail of payload.error.details) {
      if (isJsonObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
          && typeof detail.retryDelay === "string" && detail.retryDelay.endsWith("s")) {
        const delay = delayMilliseconds(detail.retryDelay.slice(0, -1));
        if (delay !== null) delays.push(delay);
      }
    }
  }
  return delays.length ? Math.max(...delays) : null;
}
// Keep retry evidence independent of the existing permanent-token parser.
// A coherent top-level status can establish the transient outcome, but every
// supplied detail must be a typed object and every FcmError must agree.
// Other well-formed typed detail envelopes (e.g. RetryInfo) neither establish
// nor contradict that outcome. BadRequest remains incompatible with replay.
function hasConsistentTransientEvidence(payload: unknown, httpStatus: number, expected: string): boolean {
  if (!isJsonObject(payload) || !isJsonObject(payload.error)) return false;
  const error = payload.error;
  if (error.status !== expected ||
      ("code" in error && error.code !== httpStatus) ||
      ("message" in error && typeof error.message !== "string")) return false;
  if (!("details" in error)) return true;
  if (!Array.isArray(error.details)) return false;
  return error.details.every((detail) => {
    if (!isJsonObject(detail) || typeof detail["@type"] !== "string" ||
        !/^type\.googleapis\.com\/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(detail["@type"])) return false;
    if (detail["@type"] === "type.googleapis.com/google.rpc.BadRequest") return false;
    return detail["@type"] !== "type.googleapis.com/google.firebase.fcm.v1.FcmError" ||
      detail.errorCode === expected;
  });
}

function failureClassFor(response: Response, payload: unknown, permanent: boolean): FirebaseFailureClass {
  if (permanent) return "permanent_device";
  if (response.status === 429) return "confirmed_transient";
  const expected = response.status === 500 ? "INTERNAL" : response.status === 503 ? "UNAVAILABLE" : null;
  if (expected && hasConsistentTransientEvidence(payload, response.status, expected)) {
    return "confirmed_transient";
  }
  if ([400, 401, 403, 404, 409].includes(response.status)) return "non_retryable";
  return "unknown_outcome";
}

export async function sendFirebaseMessage(
  authorization: FirebaseAuthorization,
  message: FirebaseMessage,
): Promise<FirebaseSendResult> {
  const endpoint = `https://fcm.googleapis.com/v1/projects/${
    encodeURIComponent(authorization.projectId)
  }/messages:send`;
  let response: Response;
  let payload: unknown;

  try {
    ({ response, payload } = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization.accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: {
              title: "Maternal Care",
              body:
                "You have a new reminder. Open Maternal Care to view details.",
            },
            data: {
              notification_id: message.notificationId,
              notification_type: message.notificationType,
              route: message.route,
            },
            android: { priority: "HIGH" },
          },
        }),
      },
      FCM_REQUEST_TIMEOUT_MS,
    ));
  } catch {
    return {
      ok: false,
      httpStatus: null,
      errorCode: "FCM_OUTCOME_UNKNOWN",
      errorMessage:
        "FCM request failed before a response was received; delivery outcome is unknown.",
      permanentTokenFailure: false,
      failureClass: "unknown_outcome",
      retryAfterMs: null,
    };
  }

  if (response.ok) {
    const providerMessageId = isJsonObject(payload) &&
        typeof payload.name === "string" &&
        payload.name.trim() &&
        payload.name.length <= 512
      ? payload.name.trim()
      : null;
    return { ok: true, httpStatus: response.status, providerMessageId };
  }

  const details = getFcmErrorDetails(payload);
  const rawCode = details.errorCode || details.status;
  const errorCode = sanitizeErrorCode(rawCode, response.status);
  const permanentTokenFailure = errorCode === "UNREGISTERED" ||
    (errorCode === "INVALID_ARGUMENT" && details.invalidTokenField) ||
    (response.status === 400 && details.invalidTokenFcmError);

  const failureClass = failureClassFor(response, payload, permanentTokenFailure);
  return {
    ok: false,
    httpStatus: response.status,
    errorCode,
    errorMessage: failureClass === "unknown_outcome"
      ? "FCM response did not establish a safe retry outcome."
      : getSafeErrorMessage(
      errorCode,
      response.status,
      permanentTokenFailure,
    ),
    permanentTokenFailure,
    failureClass,
    retryAfterMs: failureClass === "confirmed_transient" ? getRetryAfterMs(response, payload) : null,
  };
}
