// Actual Edge entrypoint with synthetic Auth/DB/transport. Never starts a listener.
const ACTOR = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const SCHEDULE = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "44444444-4444-4444-8444-444444444444";
const DISPATCH = "55555555-5555-4555-8555-555555555555";
const SECRET = "sb_secret_synthetic_appointment_handler";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Synthetic appointment handler assertion failed");
}

async function fixture(options: {
  role?: string; status?: string; doctorId?: string; transportError?: boolean;
} = {}) {
  let handler: (request: Request) => Promise<Response>;
  let calls = 0, claims = 0;
  const keys = new Set<string>();
  const appointment = Object.freeze({ id: SCHEDULE, patient_id: PATIENT,
    doctor_id: options.doctorId ?? ACTOR, title: "Synthetic appointment", description: null,
    start_time: "2026-10-21T00:00:00Z", end_time: "2026-10-21T00:30:00Z", status: "scheduled" });
  const runtime = {
    createClient: () => ({
      auth: { getUser: (token: string) => Promise.resolve({
        data: { user: token === "synthetic-valid-jwt" ? { id: ACTOR } : null }, error: null,
      }) },
      from: (table: string) => {
        assert(["profiles", "schedule"].includes(table));
        const query = {
          select: () => query,
          eq: (column: string, value: string) => {
            assert(column === "id" && value === (table === "profiles" ? ACTOR : SCHEDULE)); return query;
          },
          maybeSingle: () => Promise.resolve({ data: table === "profiles"
            ? { id: ACTOR, role: options.role ?? "staff", account_status: options.status ?? "active" }
            : appointment, error: null }),
        }; return query;
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        assert(name === "claim_notification_dispatch" && args.p_patient_id === PATIENT);
        claims++;
        const key = String(args.p_dispatch_key), fresh = !keys.has(key); keys.add(key);
        return Promise.resolve({ data: [{ dispatch_id: DISPATCH, dispatch_status: "processing",
          newly_claimed: fresh, may_send: fresh, retry_eligible: false }], error: null });
      },
    }),
    deno: {
      env: { get: (name: string) => name === "SUPABASE_URL" ? "https://synthetic.invalid"
        : name === "SUPABASE_SECRET_KEY" ? SECRET : undefined },
      serve: (callback: typeof handler) => { handler = callback; },
    },
    console: { info() {}, error() {} },
    fetch: (url: string, request: RequestInit) => {
      assert(url === "https://synthetic.invalid/functions/v1/send-notification-sms");
      const body = JSON.parse(String(request.body));
      assert(body.dispatch_id === DISPATCH && !/[^\x20-\x7e]/.test(body.message));
      calls++;
      if (options.transportError) return Promise.reject(new Error("Synthetic uncertain transport"));
      return Promise.resolve(Response.json({ ok: true, sent: false, skipped: true,
        status: "cancelled", reason: "appointment_event_sms_disabled" }));
    },
  };
  const key = `appointment_handler_${crypto.randomUUID()}`;
  const registry = globalThis as unknown as Record<string, unknown>;
  registry[key] = runtime;
  let source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  source = source.replace('import { createClient, type SupabaseClient } from "@supabase/supabase-js";', "")
    .replace(/from "(\.\.[^"]+)"/g, (_match, relative) => `from "${new URL(relative, import.meta.url).href}"`)
    .replaceAll("Deno.", "_runtime.deno.").replace(/\bfetch\(/g, "_runtime.fetch(");
  source = `const _runtime = globalThis[${JSON.stringify(key)}];
const createClient = _runtime.createClient;
type SupabaseClient = ReturnType<typeof createClient>;
const console = _runtime.console;
` + source;
  try { await import(`data:application/typescript;base64,${btoa(source)}`); }
  finally { delete registry[key]; }
  assert(typeof handler! === "function");
  return {
    calls: () => calls, claims: () => claims,
    request: (auth: string | null = "synthetic-valid-jwt", body: Record<string, unknown> = {}, serverKey?: string) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (auth) headers.authorization = `Bearer ${auth}`;
      if (serverKey) headers.apikey = serverKey;
      return handler!(new Request("https://example.test/appointment-sms", { method: "POST", headers,
        body: JSON.stringify({ event: "appointment_confirmed", schedule_id: SCHEDULE, ...body }) }));
    },
  };
}

for (const [label, options, auth, expected] of [
  ["no JWT", {}, null, 401], ["invalid JWT", {}, "invalid", 401],
  ["Patient", { role: "patient" }, "synthetic-valid-jwt", 403],
  ["inactive Staff", { status: "inactive" }, "synthetic-valid-jwt", 403],
  ["foreign Doctor", { role: "doctor", doctorId: FOREIGN }, "synthetic-valid-jwt", 403],
] as const) Deno.test(`actual appointment handler rejects ${label} before claim or transport`, async () => {
  const f = await fixture(options); assert((await f.request(auth)).status === expected);
  assert(f.claims() === 0 && f.calls() === 0);
});
for (const role of ["staff", "doctor", "admin"]) Deno.test(`actual ${role} handler uses stored Patient and preserves disabled success`, async () => {
  const f = await fixture({ role });
  const response = await f.request("synthetic-valid-jwt", { patient_id: FOREIGN, actor_role: "admin", appointment_event_sms_enabled: true });
  const result = await response.json();
  assert(response.status === 200 && result.skipped && result.reason === "appointment_event_sms_disabled");
  assert(f.claims() === 1 && f.calls() === 1);
});
Deno.test("actual appointment handler refuses server-secret confirmation and invalid server secret", async () => {
  const f = await fixture();
  assert((await f.request(null, {}, SECRET)).status === 403);
  assert((await f.request(null, {}, "sb_secret_wrong_synthetic")).status === 401);
  assert(f.claims() === 0 && f.calls() === 0);
});
Deno.test("actual appointment handler refuses user reminder and concurrent duplicate transport", async () => {
  const f = await fixture();
  assert((await f.request("synthetic-valid-jwt", { event: "appointment_reminder",
    scheduled_for: "2026-10-20T00:00:00Z", reminder_offset_minutes: 1440 })).status === 403);
  assert(f.claims() === 0 && f.calls() === 0);
  await Promise.all([f.request(), f.request()]); assert(f.calls() === 1 && f.claims() === 2);
});
Deno.test("actual appointment handler never blindly repeats an uncertain transport", async () => {
  const f = await fixture({ transportError: true });
  assert((await f.request()).status === 502);
  assert((await f.request()).status === 200);
  assert(f.calls() === 1 && f.claims() === 2);
});
