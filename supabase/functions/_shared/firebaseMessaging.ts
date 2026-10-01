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
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAccessToken(
  serviceAccount: ServiceAccount,
): Promise<FirebaseAuthorization> {
  const assertion = await createServiceAccountAssertion(serviceAccount);
  let response: Response;

  try {
    response = await fetchWithTimeout(
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
    );
  } catch {
    throw new FirebaseConfigurationError("oauth_network_error");
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Only validated fields are used below; raw OAuth responses are never exposed.
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
} {
  if (!isJsonObject(payload) || !isJsonObject(payload.error)) {
    return { status: null, errorCode: null, invalidTokenField: false };
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

  return { status, errorCode, invalidTokenField };
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

export async function sendFirebaseMessage(
  authorization: FirebaseAuthorization,
  message: FirebaseMessage,
): Promise<FirebaseSendResult> {
  const endpoint = `https://fcm.googleapis.com/v1/projects/${
    encodeURIComponent(authorization.projectId)
  }/messages:send`;
  let response: Response;

  try {
    response = await fetchWithTimeout(
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
    );
  } catch {
    return {
      ok: false,
      httpStatus: null,
      errorCode: "FCM_OUTCOME_UNKNOWN",
      errorMessage:
        "FCM request failed before a response was received; delivery outcome is unknown.",
      permanentTokenFailure: false,
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Raw provider responses are intentionally not retained or exposed.
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
    (errorCode === "INVALID_ARGUMENT" && details.invalidTokenField);

  return {
    ok: false,
    httpStatus: response.status,
    errorCode,
    errorMessage: getSafeErrorMessage(
      errorCode,
      response.status,
      permanentTokenFailure,
    ),
    permanentTokenFailure,
  };
}
