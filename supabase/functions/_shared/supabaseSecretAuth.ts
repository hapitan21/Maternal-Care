export type EnvironmentReader = (name: string) => string | undefined;

type JsonObject = Record<string, unknown>;

export class SupabaseSecretConfigurationError extends Error {
  constructor() {
    super("server_configuration_error");
    this.name = "SupabaseSecretConfigurationError";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function getDefaultSupabaseSecretKey(readEnvironment: EnvironmentReader): string {
  const secretKeysJson = readEnvironment("SUPABASE_SECRET_KEYS")?.trim();

  if (secretKeysJson) {
    try {
      const parsed = JSON.parse(secretKeysJson);
      if (
        isJsonObject(parsed) &&
        typeof parsed.default === "string" &&
        parsed.default.trim().startsWith("sb_secret_")
      ) {
        return parsed.default.trim();
      }
    } catch {
      throw new SupabaseSecretConfigurationError();
    }

    throw new SupabaseSecretConfigurationError();
  }

  const singleSecretKey = readEnvironment("SUPABASE_SECRET_KEY")?.trim();
  if (singleSecretKey?.startsWith("sb_secret_")) return singleSecretKey;

  throw new SupabaseSecretConfigurationError();
}

export async function authenticateSupabaseSecretRequest(
  request: Request,
  readEnvironment: EnvironmentReader,
): Promise<string | null> {
  const suppliedApiKey = request.headers.get("apikey")?.trim() || "";
  if (!suppliedApiKey.startsWith("sb_secret_")) return null;

  const expectedSecretKey = getDefaultSupabaseSecretKey(readEnvironment);
  return await timingSafeEqual(suppliedApiKey, expectedSecretKey)
    ? expectedSecretKey
    : null;
}

export async function executeWithSupabaseSecretAuthentication<T>(
  request: Request,
  readEnvironment: EnvironmentReader,
  authenticatedHandler: (secretKey: string) => Promise<T>,
): Promise<{ authenticated: false } | { authenticated: true; value: T }> {
  const secretKey = await authenticateSupabaseSecretRequest(
    request,
    readEnvironment,
  );
  if (!secretKey) return { authenticated: false };

  return {
    authenticated: true,
    value: await authenticatedHandler(secretKey),
  };
}
