import {
  maskPhoneNumber,
  normalizePhilippinePhoneNumber,
  normalizeSemaphoreStatus,
  parseSemaphoreResponse,
  SemaphoreResponseError,
} from "../_shared/semaphoreSms.ts";
import {
  buildSmsDispatchFailureUpdate,
  buildSmsDispatchSuccessUpdate,
  executeWithSmsTransportReservation,
  mayContactSemaphore,
  reserveSmsTransport,
  type SmsDispatchRow,
  type SmsTransportReservationStore,
} from "../_shared/smsTransportReservation.ts";
import {
  authenticateSupabaseSecretRequest,
  executeWithSupabaseSecretAuthentication,
  type EnvironmentReader,
} from "../_shared/supabaseSecretAuth.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

const TEST_DISPATCH_ID = "11111111-1111-4111-8111-111111111111";
const TEST_PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const TEST_SERVER_SECRET = "sb_secret_valid_server_test_key";
const readTestEnvironment: EnvironmentReader = (name) =>
  name === "SUPABASE_SECRET_KEYS"
    ? JSON.stringify({ default: TEST_SERVER_SECRET })
    : undefined;

function createReservationStore(
  status = "processing",
  provider: string | null = null,
): {
  store: SmsTransportReservationStore;
  getDispatch: () => SmsDispatchRow;
} {
  let dispatch: SmsDispatchRow = {
    id: TEST_DISPATCH_ID,
    patient_id: TEST_PATIENT_ID,
    channel: "sms",
    status,
    provider,
  };

  return {
    store: {
      tryReserve: (dispatchId) => {
        if (
          dispatch.id === dispatchId &&
          dispatch.channel === "sms" &&
          dispatch.status === "processing" &&
          dispatch.provider === null
        ) {
          dispatch = { ...dispatch, provider: "semaphore" };
          return Promise.resolve({ data: { ...dispatch }, error: null });
        }

        return Promise.resolve({ data: null, error: null });
      },
      load: (dispatchId) => Promise.resolve({
        data: dispatch.id === dispatchId ? { ...dispatch } : null,
        error: null,
      }),
    },
    getDispatch: () => ({ ...dispatch }),
  };
}

Deno.test("normalizes supported Philippine mobile-number formats", () => {
  assertEquals(normalizePhilippinePhoneNumber("09171234567"), "639171234567");
  assertEquals(normalizePhilippinePhoneNumber("639171234567"), "639171234567");
  assertEquals(normalizePhilippinePhoneNumber("+639171234567"), "639171234567");
  assertEquals(normalizePhilippinePhoneNumber("917 123 4567"), "639171234567");
  assertEquals(normalizePhilippinePhoneNumber("02 8123 4567"), null);
});

Deno.test("masks a normalized phone number", () => {
  assertEquals(maskPhoneNumber("639171234567"), "09*****4567");
});

Deno.test("maps Semaphore statuses without treating Sent as delivered", () => {
  assertEquals(normalizeSemaphoreStatus("Queued"), "sent");
  assertEquals(normalizeSemaphoreStatus("Pending"), "sent");
  assertEquals(normalizeSemaphoreStatus("Sent"), "sent");
  assertEquals(normalizeSemaphoreStatus("Failed"), "failed");
  assertEquals(normalizeSemaphoreStatus("Refunded"), "failed");
  assertEquals(normalizeSemaphoreStatus("Delivered"), null);
});

Deno.test("parses a valid Semaphore response", () => {
  const parsed = parseSemaphoreResponse([
    { message_id: 12345, status: "Pending" },
  ]);

  assertEquals(parsed.messageId, "12345");
  assertEquals(parsed.providerStatus, "pending");
  assertEquals(parsed.dispatchStatus, "sent");
});

Deno.test("rejects malformed Semaphore responses", () => {
  let error: unknown;

  try {
    parseSemaphoreResponse({ message_id: 12345, status: "Pending" });
  } catch (caughtError) {
    error = caughtError;
  }

  assertEquals(error instanceof SemaphoreResponseError, true);
});

Deno.test("missing apikey header is rejected", async () => {
  const authenticatedSecret = await authenticateSupabaseSecretRequest(
    new Request("https://example.test/send-notification-sms"),
    readTestEnvironment,
  );

  assertEquals(authenticatedSecret, null);
});

Deno.test("publishable and anon-style credentials are rejected", async () => {
  for (const credential of [
    "sb_publishable_browser_test_key",
    "eyJhbGciOiJIUzI1NiJ9.anon-user-jwt.signature",
  ]) {
    const authenticatedSecret = await authenticateSupabaseSecretRequest(
      new Request("https://example.test/send-notification-sms", {
        headers: { apikey: credential },
      }),
      readTestEnvironment,
    );

    assertEquals(authenticatedSecret, null);
  }
});

Deno.test("an invalid secret key is rejected", async () => {
  const authenticatedSecret = await authenticateSupabaseSecretRequest(
    new Request("https://example.test/send-notification-sms", {
      headers: { apikey: "sb_secret_invalid_server_key" },
    }),
    readTestEnvironment,
  );

  assertEquals(authenticatedSecret, null);
});

Deno.test("a valid server secret in the apikey header is accepted", async () => {
  const authenticatedSecret = await authenticateSupabaseSecretRequest(
    new Request("https://example.test/send-notification-sms", {
      headers: { apikey: TEST_SERVER_SECRET },
    }),
    readTestEnvironment,
  );

  assertEquals(authenticatedSecret, TEST_SERVER_SECRET);
});

Deno.test("Authorization Bearer secret alone is rejected", async () => {
  const authenticatedSecret = await authenticateSupabaseSecretRequest(
    new Request("https://example.test/send-notification-sms", {
      headers: { authorization: `Bearer ${TEST_SERVER_SECRET}` },
    }),
    readTestEnvironment,
  );

  assertEquals(authenticatedSecret, null);
});

Deno.test("authentication failure cannot execute the transport handler", async () => {
  let transportCalls = 0;
  const authentication = await executeWithSupabaseSecretAuthentication(
    new Request("https://example.test/send-notification-sms", {
      headers: { apikey: "sb_secret_invalid_server_key" },
    }),
    readTestEnvironment,
    () => {
      transportCalls += 1;
      return Promise.resolve("unexpected-send");
    },
  );

  assertEquals(authentication.authenticated, false);
  assertEquals(transportCalls, 0);
});

Deno.test("only the first invocation obtains the SMS transport reservation", async () => {
  const { store, getDispatch } = createReservationStore();

  const first = await reserveSmsTransport(store, TEST_DISPATCH_ID);
  const second = await reserveSmsTransport(store, TEST_DISPATCH_ID);

  assertEquals(first.outcome, "reserved");
  assertEquals(mayContactSemaphore(first), true);
  assertEquals(getDispatch().provider, "semaphore");
  assertEquals(second.outcome, "already_started");
  assertEquals(mayContactSemaphore(second), false);
});

Deno.test("sent and delivered dispatches cannot contact Semaphore", async () => {
  for (const status of ["sent", "delivered"]) {
    const { store } = createReservationStore(status, "semaphore");
    const reservation = await reserveSmsTransport(store, TEST_DISPATCH_ID);

    assertEquals(reservation.outcome, "idempotent");
    assertEquals(mayContactSemaphore(reservation), false);
  }
});

Deno.test("pending, failed, and cancelled dispatches cannot send", async () => {
  for (const status of ["pending", "failed", "cancelled"]) {
    const { store } = createReservationStore(status, "semaphore");
    const reservation = await reserveSmsTransport(store, TEST_DISPATCH_ID);

    assertEquals(reservation.outcome, "not_sendable");
    assertEquals(mayContactSemaphore(reservation), false);
  }
});

Deno.test("success and failure updates preserve the Semaphore reservation", () => {
  const timestamp = "2026-09-22T12:00:00.000Z";
  const success = buildSmsDispatchSuccessUpdate("12345", timestamp);
  const failure = buildSmsDispatchFailureUpdate(
    "semaphore_timeout",
    timestamp,
  );

  assertEquals(success.provider, "semaphore");
  assertEquals(success.status, "sent");
  assertEquals(failure.provider, "semaphore");
  assertEquals(failure.status, "failed");
});

Deno.test("a losing reservation cannot execute the network path", async () => {
  const { store } = createReservationStore();
  await reserveSmsTransport(store, TEST_DISPATCH_ID);
  const losingReservation = await reserveSmsTransport(
    store,
    TEST_DISPATCH_ID,
  );
  let networkCalls = 0;

  const execution = await executeWithSmsTransportReservation(
    losingReservation,
    () => {
      networkCalls += 1;
      return Promise.resolve("unexpected-send");
    },
  );

  assertEquals(execution.executed, false);
  assertEquals(networkCalls, 0);
});
