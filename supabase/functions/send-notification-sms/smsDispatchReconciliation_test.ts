import {
  claimSmsDispatchRetry,
  classifySmsDispatch,
  type SmsDispatchRecoveryRow,
} from "../_shared/smsDispatchReconciliation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

const NOW = new Date("2026-09-23T12:00:00.000Z");
const DISPATCH_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCH_KEY = "medication:22222222-2222-4222-8222-222222222222:sms";

function dispatch(
  updates: Partial<SmsDispatchRecoveryRow> = {},
): SmsDispatchRecoveryRow {
  return {
    id: DISPATCH_ID,
    dispatch_key: DISPATCH_KEY,
    channel: "sms",
    status: "processing",
    provider: null,
    provider_message_id: null,
    attempt_count: 1,
    processing_started_at: "2026-09-23T11:55:00.000Z",
    sent_at: null,
    delivered_at: null,
    failed_at: null,
    updated_at: "2026-09-23T11:55:00.000Z",
    last_error: null,
    ...updates,
  };
}

function createRetryStore(initial: SmsDispatchRecoveryRow) {
  let current = { ...initial };

  return {
    get current() {
      return current;
    },
    store: {
      tryClaim: async ({
        dispatchId,
        expectedDispatchKey,
        staleBefore,
        attemptedAt,
      }: {
        dispatchId: string;
        expectedDispatchKey: string;
        staleBefore: string;
        attemptedAt: string;
      }) => {
        const safeProcessing = current.status === "processing" &&
          current.provider === null &&
          current.failed_at === null &&
          Boolean(current.processing_started_at) &&
          current.processing_started_at! <= staleBefore;
        const safeFailed = current.status === "failed" &&
          current.provider === null &&
          current.provider_message_id === null &&
          current.sent_at === null &&
          current.delivered_at === null &&
          Boolean(current.failed_at) &&
          current.failed_at! <= staleBefore;
        const hasNoTerminalEvidence = current.provider_message_id === null &&
          current.sent_at === null &&
          current.delivered_at === null;

        if (
          current.id !== dispatchId ||
          current.dispatch_key !== expectedDispatchKey ||
          current.channel !== "sms" ||
          ((!safeProcessing || !hasNoTerminalEvidence) && !safeFailed)
        ) {
          return { data: null, error: null };
        }

        current = {
          ...current,
          status: "processing",
          provider: null,
          attempt_count: current.attempt_count + 1,
          processing_started_at: attemptedAt,
          failed_at: null,
          updated_at: attemptedAt,
          last_error: null,
        };
        return { data: { ...current }, error: null };
      },
      load: () => Promise.resolve({ data: { ...current }, error: null }),
    },
  };
}

Deno.test("recent processing without provider is not retried prematurely", () => {
  assertEquals(classifySmsDispatch(dispatch(), NOW), "recent_processing");
});

Deno.test("stale processing with failed_at null is a safe retry candidate", async () => {
  const safeDispatch = dispatch({
    processing_started_at: "2026-09-23T11:20:00.000Z",
    failed_at: null,
  });
  assertEquals(
    classifySmsDispatch(safeDispatch, NOW),
    "safe_retry_candidate",
  );

  const harness = createRetryStore(safeDispatch);
  const result = await claimSmsDispatchRetry(
    harness.store,
    DISPATCH_ID,
    DISPATCH_KEY,
    NOW,
  );
  assertEquals(result.retryClaimed, true);
  assertEquals(result.maySend, true);
});

Deno.test("stale processing with failed_at requires review and cannot send", async () => {
  const unsafeDispatch = dispatch({
    processing_started_at: "2026-09-23T11:20:00.000Z",
    failed_at: "2026-09-23T11:25:00.000Z",
  });
  assertEquals(
    classifySmsDispatch(unsafeDispatch, NOW),
    "failed_requires_review",
  );

  const harness = createRetryStore(unsafeDispatch);
  const result = await claimSmsDispatchRetry(
    harness.store,
    DISPATCH_ID,
    DISPATCH_KEY,
    NOW,
  );

  assertEquals(result.retryClaimed, false);
  assertEquals(result.maySend, false);
  assertEquals(result.classification, "failed_requires_review");
  assertEquals(harness.current.attempt_count, 1);
});

Deno.test("processing with Semaphore reservation is never auto retried", () => {
  assertEquals(
    classifySmsDispatch(
      dispatch({
        provider: "semaphore",
        processing_started_at: "2026-09-23T10:00:00.000Z",
      }),
      NOW,
    ),
    "manual_review_transport_started",
  );
});

for (const status of ["sent", "delivered"] as const) {
  Deno.test(`${status} dispatch is terminal and never retried`, () => {
    assertEquals(
      classifySmsDispatch(dispatch({ status, provider: "semaphore" }), NOW),
      "terminal_success",
    );
  });
}

Deno.test("cancelled dispatch is terminal and never retried", () => {
  assertEquals(
    classifySmsDispatch(dispatch({ status: "cancelled" }), NOW),
    "terminal_cancelled",
  );
});

Deno.test("ambiguous provider failure requires manual review", () => {
  assertEquals(
    classifySmsDispatch(
      dispatch({
        status: "failed",
        provider: "semaphore",
        failed_at: "2026-09-23T10:00:00.000Z",
        last_error: "semaphore_timeout",
      }),
      NOW,
    ),
    "failed_requires_review",
  );
});

Deno.test("stale failed dispatch without provider is a safe retry candidate", () => {
  assertEquals(
    classifySmsDispatch(
      dispatch({
        status: "failed",
        provider: null,
        failed_at: "2026-09-23T11:20:00.000Z",
      }),
      NOW,
    ),
    "safe_retry_candidate",
  );
});

Deno.test("failed dispatch without failed_at requires manual review", () => {
  assertEquals(
    classifySmsDispatch(
      dispatch({
        status: "failed",
        provider: null,
        failed_at: null,
        updated_at: "2026-09-23T10:00:00.000Z",
      }),
      NOW,
    ),
    "failed_requires_review",
  );
});

for (const status of ["processing", "failed"] as const) {
  for (
    const [field, value] of [
      ["provider_message_id", "provider-message-123"],
      ["sent_at", "2026-09-23T11:00:00.000Z"],
      ["delivered_at", "2026-09-23T11:05:00.000Z"],
    ] as const
  ) {
    Deno.test(`${status} with ${field} requires manual review`, () => {
      const updates: Partial<SmsDispatchRecoveryRow> = {
        status,
        processing_started_at: "2026-09-23T10:00:00.000Z",
        failed_at: status === "failed"
          ? "2026-09-23T10:00:00.000Z"
          : null,
        [field]: value,
      };

      assertEquals(
        classifySmsDispatch(dispatch(updates), NOW),
        "failed_requires_review",
      );
    });
  }
}

Deno.test("safe retry preserves dispatch key and ledger row", async () => {
  const harness = createRetryStore(
    dispatch({ processing_started_at: "2026-09-23T11:20:00.000Z" }),
  );
  const result = await claimSmsDispatchRetry(
    harness.store,
    DISPATCH_ID,
    DISPATCH_KEY,
    NOW,
  );

  assertEquals(result.retryClaimed, true);
  assertEquals(result.dispatch?.id, DISPATCH_ID);
  assertEquals(result.dispatch?.dispatch_key, DISPATCH_KEY);
});

Deno.test("concurrent retry attempts allow only one winner", async () => {
  const harness = createRetryStore(
    dispatch({ processing_started_at: "2026-09-23T11:20:00.000Z" }),
  );
  const results = await Promise.all([
    claimSmsDispatchRetry(harness.store, DISPATCH_ID, DISPATCH_KEY, NOW),
    claimSmsDispatchRetry(harness.store, DISPATCH_ID, DISPATCH_KEY, NOW),
  ]);

  assertEquals(results.filter((result) => result.retryClaimed).length, 1);
  assertEquals(results.filter((result) => result.maySend).length, 1);
});

Deno.test("dispatch key mismatch never exposes retry authority", async () => {
  const harness = createRetryStore(
    dispatch({ processing_started_at: "2026-09-23T11:20:00.000Z" }),
  );
  const result = await claimSmsDispatchRetry(
    harness.store,
    DISPATCH_ID,
    "medication:different-occurrence:sms",
    NOW,
  );

  assertEquals(result.retryClaimed, false);
  assertEquals(result.maySend, false);
  assertEquals(result.classification, "dispatch_key_mismatch");
  assertEquals(harness.current.attempt_count, 1);
  assertEquals(harness.current.dispatch_key, DISPATCH_KEY);
});

Deno.test("retry winner increments attempt count exactly once", async () => {
  const harness = createRetryStore(
    dispatch({
      attempt_count: 3,
      processing_started_at: "2026-09-23T11:20:00.000Z",
    }),
  );

  await Promise.all([
    claimSmsDispatchRetry(harness.store, DISPATCH_ID, DISPATCH_KEY, NOW),
    claimSmsDispatchRetry(harness.store, DISPATCH_ID, DISPATCH_KEY, NOW),
  ]);

  assertEquals(harness.current.attempt_count, 4);
});

Deno.test("retry threshold cannot be shortened below thirty minutes", async () => {
  const harness = createRetryStore(
    dispatch({ processing_started_at: "2026-09-23T11:20:00.000Z" }),
  );
  let error: unknown = null;

  try {
    await claimSmsDispatchRetry(
      harness.store,
      DISPATCH_ID,
      DISPATCH_KEY,
      NOW,
      29 * 60 * 1000,
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof RangeError, "Expected conservative threshold guard");
  assertEquals(harness.current.attempt_count, 1);
});
