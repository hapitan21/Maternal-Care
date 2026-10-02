import {
  getPatientLinkingErrorMessage,
  isMissingPatientAuthSession,
  isMissingPatientRpcError,
} from "./patientAuthLinking";

export const loginErrorMessages = {
  network: "Unable to connect. Check your internet connection and try again.",
  credentials: "Incorrect email or password.",
  unexpected: "We couldn't sign you in right now. Please try again.",
};

// Only these intentional account messages may pass through unchanged.
const accountMessages = [
  "Your Patient account is inactive. Please contact the clinic.",
  "Your Patient account is pending Admin activation.",
  "This Patient record is archived. Please contact the clinic.",
  "No Patient record is linked to this account yet.",
  "No Patient record is linked to this account. Return to Patient Access and scan the clinic QR code.",
  "Your Doctor account has been deactivated. Please contact the administrator.",
  "Your Staff account has been deactivated. Please contact the system administrator.",
  "No account role is connected to this user. Please contact the administrator.",
  "Invalid account role.",
];
const networkCodes = /^(?:ERR_NETWORK|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)$/i;
const networkMessage = /failed to fetch|fetch failed|network\s?error|network request failed|network failure|net::err_/i;

// Used at every error-to-message boundary on both login entry points.
export function getLoginErrorMessage(error) {
  const failure = error?.error || error;
  const details = typeof failure === "string" ? { message: failure } : failure;
  const message = String(details?.message || "").toLowerCase();

  // An actual credential response takes precedence over connectivity hints.
  if (details?.code === "invalid_credentials" ||
      /invalid (?:login )?credentials|(?:invalid|incorrect) email or password/.test(message)) {
    return loginErrorMessages.credentials;
  }
  if (details?.code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "Please verify your email address before logging in.";
  }
  if (details?.code === "over_request_rate_limit" ||
      /rate limit|too many requests/.test(message)) {
    return "Too many login attempts. Please wait a moment and try again.";
  }

  const transportFailure = [details, details?.cause].some((candidate) => {
    const text = typeof candidate === "string" ? candidate : candidate?.message || "";
    // HTTP 5xx is also retryable in Supabase Auth, but is not proof of a failed transport.
    return (candidate?.name === "AuthRetryableFetchError" && candidate?.status === 0) ||
      candidate?.name === "NetworkError" || networkCodes.test(candidate?.code || "") ||
      networkMessage.test(text) || /^(?:typeerror: )?load failed$/i.test(text);
  });
  if (transportFailure) return loginErrorMessages.network;

  const accountMessage = accountMessages.find((safe) => safe.toLowerCase() === message);
  if (accountMessage) return accountMessage;
  if (isMissingPatientAuthSession(details)) {
    return "Your session has expired. Log in again to continue.";
  }
  if (isMissingPatientRpcError(details)) return loginErrorMessages.unexpected;
  return getPatientLinkingErrorMessage(details, loginErrorMessages.unexpected);
}
