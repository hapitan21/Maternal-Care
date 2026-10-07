import { sendIprogSms } from "../_shared/iprogSms.ts";
import {
  classifySmsDispatch,
  type SmsDispatchRecoveryRow,
} from "../_shared/smsDispatchReconciliation.ts";

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Transport assertion failed");
}

const DISPATCH_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_SECRET = "sb_secret_synthetic_transport_test";
const TOKEN = "synthetic-transport-token";
const PHONE = "639171234567";
const MESSAGE = "Maternal Care: synthetic transport test message";
const NOW = "2026-10-07T00:00:00.000Z";

async function fixture(options: {
  provider?: string | null;
  status?: string;
  phone?: string;
  response?: (signal: AbortSignal) => Promise<Response>;
  timeoutMs?: number;
  failSuccessWrite?: boolean;
  missingToken?: boolean;
} = {}) {
  const row: SmsDispatchRecoveryRow & { patient_id: string } = {
    id: DISPATCH_ID,
    patient_id: PATIENT_ID,
    channel: "sms",
    dispatch_key: `appointment:${DISPATCH_ID}:confirmed:sms`,
    status: options.status ?? "processing",
    provider: options.provider ?? null,
    provider_message_id: null,
    attempt_count: 1,
    processing_started_at: NOW,
    sent_at: null,
    delivered_at: null,
    failed_at: null,
    updated_at: NOW,
    last_error: null,
  } as SmsDispatchRecoveryRow & { patient_id: string };
  const updates: Record<string, unknown>[] = [];
  const logs: unknown[][] = [];
  let calls = 0;
  const readEnvironment = (name: string) => {
    if (name === "SUPABASE_URL") return "https://example.test";
    if (name === "SUPABASE_SECRET_KEYS") {
      return JSON.stringify({ default: SERVER_SECRET });
    }
    if (name === "IPROGSMS_API_TOKEN" && !options.missingToken) return TOKEN;
    return undefined;
  };
  const createClient = () => ({
    from(table: string) {
      const filters = new Map<string, unknown>();
      let update: Record<string, unknown> | null = null;
      const query = {
        select(_columns: string) {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        is(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        update(value: Record<string, unknown>) {
          update = value;
          return query;
        },
        maybeSingle() {
          if (table === "patients") {
            assert(filters.get("id") === PATIENT_ID);
            return Promise.resolve({
              data: {
                id: PATIENT_ID,
                contact_number: options.phone ?? "09171234567",
              },
              error: null,
            });
          }
          assert(table === "notification_dispatches");
          for (const [column, value] of filters) {
            if ((row as unknown as Record<string, unknown>)[column] !== value) {
              return Promise.resolve({ data: null, error: null });
            }
          }
          if (update) {
            if (options.failSuccessWrite && update.status === "sent") {
              return Promise.resolve({
                data: null,
                error: { code: "synthetic-write-failure" },
              });
            }
            updates.push({ ...update });
            Object.assign(row, update);
          }
          return Promise.resolve({ data: { ...row }, error: null });
        },
      };
      return query;
    },
  });

  let handler: (request: Request) => Promise<Response>;
  const runtime = {
    createClient,
    deno: {
      env: { get: readEnvironment },
      serve: (value: typeof handler) => {
        handler = value;
      },
    },
    console: {
      info: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
    },
    sendIprogSms: (input: { phoneNumber: string; message: string }) =>
      sendIprogSms(input, {
        readEnvironment,
        timeoutMs: options.timeoutMs,
        fetch: (_url, request) => {
          calls++;
          const body = JSON.parse(String(request?.body));
          assert(
            body.api_token === TOKEN && body.phone_number === PHONE &&
              body.message === MESSAGE,
          );
          return options.response?.(request!.signal!) ??
            Promise.resolve(Response.json({
              status: 200,
              message_id: "iSms-transport123",
              sms_rate: 1,
              message_status_link:
                `https://example.test/status?api_token=${TOKEN}`,
            }));
        },
      }),
  };

  // Load the actual handler with only its external runtime replaced. No real
  // Supabase client, listener, environment secret, or provider network is used.
  const contextKey = `sms_test_${crypto.randomUUID()}`;
  const registry = globalThis as unknown as Record<string, unknown>;
  registry[contextKey] = runtime;
  let source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  source = source.replace(
    'import { createClient, type SupabaseClient } from "@supabase/supabase-js";',
    "",
  );
  source = source.replace(/ {2}sendIprogSms,\r?\n/, "");
  source = source.replace(
    /from "(\.\.[^"]+)"/g,
    (_match, path) => `from "${new URL(path, import.meta.url).href}"`,
  );
  source = source.replaceAll("Deno.", "_runtime.deno.");
  source = `const _runtime = globalThis[${JSON.stringify(contextKey)}];
const createClient = _runtime.createClient;
type SupabaseClient = ReturnType<typeof createClient>;
const sendIprogSms = _runtime.sendIprogSms;
const console = _runtime.console;
` + source;
  try {
    await import(`data:application/typescript;base64,${btoa(source)}`);
  } finally {
    delete registry[contextKey];
  }
  assert(typeof handler! === "function");
  return {
    row,
    updates,
    logs,
    calls: () => calls,
    request: (apikey = SERVER_SECRET) =>
      handler!(
        new Request("https://example.test/sms", {
          method: "POST",
          headers: { apikey, "content-type": "application/json" },
          // Privileged callers still cannot override the database phone/provider.
          body: JSON.stringify({
            dispatch_id: DISPATCH_ID,
            message: MESSAGE,
            phone_number: "639999999999",
            api_token: "client-token",
            provider: "client-provider",
            url: "https://wrong.test",
          }),
        }),
      ),
  };
}

function assertPrivate(
  f: Awaited<ReturnType<typeof fixture>>,
  response: unknown,
) {
  const serialized = JSON.stringify({
    response,
    row: f.row,
    updates: f.updates,
    logs: f.logs,
  });
  assert(!serialized.includes(TOKEN));
  assert(!serialized.includes("api_token"));
  assert(!serialized.includes("message_status_link"));
  assert(!serialized.includes(PHONE));
  assert(!serialized.includes(MESSAGE));
  assert(!serialized.includes("sms_rate"));
}

Deno.test("actual secured handler stores only accepted ID; never delivery/raw receipt data", async () => {
  const f = await fixture();
  const response = await f.request();
  const result = await response.json();
  assert(response.status === 200 && result.sent === true);
  assert(f.row.provider === "iprogsms" && f.row.status === "sent");
  assert(
    f.row.provider_message_id === "iSms-transport123" && f.row.sent_at !== null,
  );
  assert(f.row.delivered_at === null && f.row.attempt_count === 1);
  assert(!f.updates.some((update) => "delivered_at" in update));
  assertPrivate(f, result);
  await f.request();
  assert(f.calls() === 1);
});

for (const provider of ["semaphore", "iprogsms", "future-provider"]) {
  Deno.test(`${provider} processing reservation cannot be resent or rewritten`, async () => {
    const f = await fixture({ provider });
    const response = await f.request();
    const result = await response.json();
    assert(response.status === 409 && result.provider === provider);
    assert(
      f.calls() === 0 && f.updates.length === 0 && f.row.provider === provider,
    );
  });
}
for (const status of ["sent", "delivered", "failed", "cancelled", "pending"]) {
  Deno.test(`historical Semaphore ${status} dispatch never contacts new provider`, async () => {
    const f = await fixture({ status, provider: "semaphore" });
    await f.request();
    assert(f.calls() === 0 && f.updates.length === 0);
  });
}

Deno.test("concurrent actual handler reservations issue exactly one provider request", async () => {
  const f = await fixture();
  await Promise.all([f.request(), f.request()]);
  assert(f.calls() === 1 && f.row.provider === "iprogsms");
  assert(f.updates.filter((update) => !update.status).length === 1);
});

Deno.test("accepted send with failed ledger write stays reserved and cannot resend", async () => {
  const f = await fixture({ failSuccessWrite: true });
  assert((await f.request()).status === 500);
  assert(f.row.status === "processing" && f.row.provider === "iprogsms");
  assert(classifySmsDispatch(f.row) === "manual_review_transport_started");
  await f.request();
  assert(f.calls() === 1);
});

for (
  const failure of ["network", "timeout", "json", "rejected", "http"] as const
) {
  Deno.test(`actual handler ${failure} failure stays reserved, safe and never resends`, async () => {
    const f = await fixture({
      timeoutMs: failure === "timeout" ? 1 : undefined,
      response: (signal) => {
        if (failure === "timeout") {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error(TOKEN)), {
              once: true,
            });
          });
        }
        if (failure === "network") return Promise.reject(new Error(TOKEN));
        if (failure === "json") return Promise.resolve(new Response(TOKEN));
        if (failure === "http") {
          return Promise.resolve(new Response(TOKEN, { status: 500 }));
        }
        return Promise.resolve(Response.json({ status: 400, message: TOKEN }));
      },
    });
    const response = await f.request();
    const result = await response.json();
    assert(
      response.status === 502 && f.row.status === "failed" &&
        f.row.provider === "iprogsms",
    );
    assert(classifySmsDispatch(f.row) === "failed_requires_review");
    assertPrivate(f, result);
    await f.request();
    assert(f.calls() === 1);
  });
}

Deno.test("missing token and invalid phone never contact provider", async () => {
  for (const options of [{ missingToken: true }, { phone: "invalid" }]) {
    const f = await fixture(options);
    const response = await f.request();
    assert([422, 500].includes(response.status));
    assert(
      f.calls() === 0 && f.row.provider === "iprogsms" &&
        f.row.status === "failed",
    );
  }
});

Deno.test("raw transport rejects ordinary browser and invalid server credentials", async () => {
  for (const key of ["sb_publishable_synthetic", "sb_secret_invalid", ""]) {
    const f = await fixture();
    assert((await f.request(key)).status === 401);
    assert(f.calls() === 0 && f.updates.length === 0);
  }
});
