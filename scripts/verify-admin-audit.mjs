// Offline only. Real JS helper/hook/presentation, in-memory React and Supabase.
// SQL checks below inspect the proposed text; they do NOT execute PostgreSQL.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { parse } from "espree";
import { getAuditEventDetails } from "../src/lib/adminAuditPresentation.js";

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const helper = read("src/lib/auditLog.js");
const hook = read("src/hooks/useAdminAuditLogs.js");
const sql = read("docs/sql-drafts/20261018_admin_audit_production_only_proposal.sql");
const client = sql.match(/as \$client\$([\s\S]*?)\$client\$/)[1];
let scenarios = 0, assertions = 0;
const check = (actual, expected, label) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label); assertions++; };
const scenario = async (name, run) => { await run(); scenarios++; console.log(`PASS ${name}`); };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = text => text.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "").replaceAll("import.meta.env.DEV", "false");
const actorId = "11111111-1111-4111-8111-111111111111";
const auditModules = ["appointment_management", "authentication", "patient_management", "reminder_management", "reports", "system_settings", "user_management", "visit_records"];

function helperFixture(result, throws = false) {
  const calls = [];
  const c = vm.createContext({ console, supabase: { rpc: async (name, payload) => {
    calls.push({ name, payload }); if (throws) throw Error("synthetic timeout"); return result;
  } } });
  vm.runInContext(plain(helper), c);
  return { calls, send: vm.runInContext("recordAuditEvent", c) };
}
for (const role of ["Admin", "Doctor", "Staff", "Patient"]) {
  for (const action of ["login", "logout"]) await scenario(`${role} ${action} caller remains API-compatible`, async () => {
    const f = helperFixture({ data: "synthetic-event", error: null });
    await f.send({ module: "authentication", action, entityType: "auth_user", entityId: action === "login" ? actorId : undefined, description: `User logged ${action === "login" ? "in" : "out"}.` });
    check(f.calls.length, 1); check(f.calls[0].name, "record_audit_event");
    check(f.calls[0].payload.p_action, action); check("p_actor_role" in f.calls[0].payload, false);
  });
}
for (const format of ["pdf", "excel", "print"]) await scenario(`Admin report ${format} payload is preserved`, async () => {
  const f = helperFixture({ data: "event", error: null });
  await f.send({ module: "reports", action: format === "print" ? "print" : "export", entityType: "report",
    entityId: "appointment-summary-2026-10-01-to-2026-10-18", description: "Prepared a report.", metadata: { format, report: "Appointment Summary Report" } });
  check(f.calls[0].payload.p_metadata, { format, report: "Appointment Summary Report" }); check(f.calls.length, 1);
});
for (const throws of [false, true]) await scenario("Audit RPC failure/uncertainty never retries or throws into completed action", async () => {
  const f = helperFixture({ data: null, error: { code: "42501" } }, throws);
  const result = await f.send({ module: "authentication", action: "login" });
  check(Boolean(result.error), true); check(f.calls.length, 1);
});

await scenario("SQL contract: public wrapper has no client-selectable success path or direct writes", async () => {
  check((client.match(/return public\.record_internal_audit_event\([^;]+,'reported'\)/g) || []).length, 1);
  check(/\b(insert|update|delete|execute)\b/i.test(client), false);
  check(client.includes("v_module='authentication' and v_action in ('login','logout')"), true);
  check(client.includes("v_module='reports' and v_role='admin'"), true);
  for (const module of ["visit_records", "appointment_management", "patient_management", "system_settings", "user_management"]) {
    check(client.includes(`v_module='${module}'`), false, `${module} cannot enter a client allow branch`);
  }
  check(client.includes("Business success events may only be recorded by trusted transactional writers."), true);
});
await scenario("SQL contract: missing/inactive auth, wrong targets and arbitrary metadata are rejected", async () => {
  for (const guard of ["if auth.uid() is null", "v_status <> 'active'", "v_role not in ('admin','doctor','staff','patient')",
    "v_type is distinct from 'auth_user'", "v_target <> auth.uid()::text", "v_metadata <> '{}'::jsonb",
    "keys.key not in ('format','report')", "v_prefix is null or v_target is null", "using errcode='42501'"]) check(client.includes(guard), true);
  check(sql.includes("Audit content contains prohibited sensitive information."), true);
  check(client.includes("bearer[[:space:]]+"), true);
  check(sql.includes("v_metadata || pg_catalog.jsonb_build_object('event_source'"), true);
  check(sql.includes("from public, anon, authenticated, service_role;"), true);
  check(sql.includes("Unexpected inherited access to internal audit writer"), true);
});
await scenario("SQL contract: all three legitimate report contracts match actual frontend models", async () => {
  const source = read("src/pages/admin/AdminReports.jsx");
  for (const [title, prefix] of [["Appointment Summary Report", "appointment-summary"], ["Patient Summary Report", "patient-summary"], ["Registration & Appointment Trends", "registration-appointment-trends"]]) {
    check(source.includes(`title: "${title}"`), true); check(source.includes(`filename: \`${prefix}-`), true);
    check(client.includes(`when '${title}' then '${prefix}'`), true);
  }
});
await scenario("SQL contract: exact baseline guards and single-call changes preserve transactional Admin writers", async () => {
  for (const [name, file] of [["record_audit_event", "supabase/migrations/20260928030000_profiles_security_stage1.sql"],
    ["admin_set_patient_account_status", "supabase/migrations/20260928040000_admin_patient_status_consistency.sql"],
    ["admin_set_doctor_account_status", "supabase_admin_user_management.sql"], ["admin_set_staff_account_status", "supabase_admin_user_management.sql"]]) {
    const source = read(file), start = source.indexOf(`create or replace function public.${name}(`);
    const body = source.slice(start).match(/as \$function\$([\s\S]*?)\$function\$;/)[1];
    const hash = crypto.createHash("md5").update(body).digest("hex"); check(sql.includes(hash), true);
    if (name.startsWith("admin_")) {
      check((body.match(/perform public\.record_audit_event\(/g) || []).length, 1);
      check(body.lastIndexOf("update public.") < body.indexOf("perform public.record_audit_event("), true);
      check(body.includes("exception when others"), false, "audit errors must propagate and roll back the status transaction");
    }
  }
  check(sql.includes("execute pg_catalog.replace(v_definition,v_old,'public.record_internal_audit_event(')"), true);
  check(sql.includes("v_old :="), false); // replacement needle is a fixed declaration, not client input
  check(sql.includes("'success'"), true); check(sql.includes("'reported'"), true);
  check(/(?:grant|revoke)\s+.*on\s+(?:table\s+)?public\.audit_logs/i.test(sql), false);
  check(sql.includes("alter table public.audit_logs enable"), false);
});

function hookFixture(options = {}) {
  let cursor = 0, slots = [], effects = [], pending = [], result;
  const cache = new Map(), timers = new Map(), queries = [], channels = [], listeners = new Map();
  let timerId = 0, filters = { startIso: "start", endIso: "end", user: "all", module: "all", action: "all", page: 1 }, enabled = true, adminId = "synthetic-admin";
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const events = prefix => ({ addEventListener: (name, fn) => listeners.set(`${prefix}:${name}`, fn), removeEventListener: name => listeners.delete(`${prefix}:${name}`) });
  const rows = Array.from({ length: 24 }, (_, i) => ({ id: `event-${i}`, actor_user_id: actorId, actor_name: "Synthetic Admin", actor_role: options.mixedRoles ? ["admin", "doctor", "staff", "patient"][i % 4] : "admin", module: options.mixedModules ? auditModules[i % auditModules.length] : "authentication", action: "login", status: "reported", entity_id: `record-${i}`, description: "Synthetic login event.", created_at: `2026-10-18T00:00:${String(i).padStart(2,"0")}Z` }));
  const context = vm.createContext({ console,
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || !depsEqual(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => { const i = cursor++; if (!slots[i] || !depsEqual(slots[i].deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useEffect: (fn, deps) => { const i = cursor++; if (!effects[i] || !depsEqual(effects[i].deps, deps)) { effects[i]?.cleanup?.(); effects[i] = { deps }; pending.push(() => { effects[i].cleanup = fn(); }); } },
    window: { ...events("window"), setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id) },
    document: { ...events("document"), visibilityState: "visible" },
    getAdminWorkspaceSnapshot: (ns, id, key) => cache.get(`${ns}:${id}:${key}`),
    setAdminWorkspaceSnapshot: (ns, id, key, value) => cache.set(`${ns}:${id}:${key}`, value),
    clearAdminWorkspaceSnapshots: (ns, id) => { for (const key of cache.keys()) if (key.startsWith(`${ns}:${id}:`)) cache.delete(key); },
    isMissingAuditInfrastructure: error => error?.code === "42P01",
    supabase: { from: table => {
      assert.equal(table, "audit_logs"); const q = { operations: [] };
      for (const method of ["select", "order", "range", "gte", "lt", "eq", "not", "limit"]) q[method] = (...args) => { q.operations.push([method, ...args]); return q; };
      q.then = (resolve, reject) => {
        queries.push(q.operations); const range = q.operations.find(op => op[0] === "range");
        const execute = async () => {
          if (options.deferPage && range) await options.deferPage;
          if (options.deferNonPage && !range) await options.deferNonPage;
          if (options.error && (!options.errorPageOnly || range)) return { error: options.error };
          const select = q.operations.find(op => op[0] === "select")?.[1] || "";
          if (options.missingOrigin && select.includes(", event_origin")) return { error: {
            code: options.missingOrigin, message: "column audit_logs.event_origin does not exist"
          } };
          if (options.staging) for (const row of rows) { row.event_origin = "client_reported"; row.status = "success"; }
          const selected = rows.filter(row => q.operations.every(op => {
            if (op[0] === "eq") return row[op[1]] === op[2];
            return true;
          }));
          const count = options.count ?? selected.length;
          const data = options.emptyPage && range ? [] : range ? selected.slice(range[1], Math.min(range[2]+1, range[1]+(options.cap ?? 10), count)) : selected.slice(0, Math.min(options.cap ?? selected.length, count));
          return { data, count, error: null };
        }; return execute().then(resolve, reject);
      }; return q;
    }, channel: (name, config) => { const channel = { name, config, on: (_type, _filter, fn) => { channel.receive = fn; return channel; }, subscribe: fn => { channel.status = fn; return channel; } }; channels.push(channel); return channel; },
    removeChannel: channel => { channel.removed = true; }, },
  });
  vm.runInContext(plain(hook), context);
  const useHook = vm.runInContext("useAdminAuditLogs", context);
  const render = () => { cursor = 0; result = useHook(filters, enabled, adminId); const work = pending; pending = []; work.forEach(fn => fn()); return result; };
  const fire = delay => { for (const [id, timer] of [...timers]) if (delay === undefined || timer.delay === delay) { timers.delete(id); timer.fn(); } };
  render();
  return { options, queries, channels, context, cache, render, fire, get result() { return result; },
    setFilters: value => { filters = { ...filters, ...value }; return render(); },
    setAdmin: value => { adminId = value; return render(); },
    disable: () => { enabled = false; return render(); },
    event: name => listeners.get(name)?.(), unmount: () => { effects.forEach(effect => effect?.cleanup?.()); },
    load: async () => { fire(0); await flush(); return render(); } };
}
await scenario("Actual hook fills a ten-row page despite lower server caps and retains exact filters", async () => {
  const f = hookFixture({ cap: 3 }); await f.load(); check(f.result.rows.length, 10); check(f.result.count, 24);
  check(f.queries.filter(q => q.some(op => op[0] === "range")).length, 4);
  f.setFilters({ page: 2, module: "authentication" }); await f.load();
  check(f.result.rows[0].id, "event-10"); check(f.result.rows.at(-1).id, "event-19");
  check(f.queries.at(-1).some(op => op[0] === "eq" && op[1] === "module" && op[2] === "authentication"), true);
  check(f.result.truncated, true); check(f.result.actorTruncated, true); f.unmount();
});
await scenario("All eight visible modules use the stored category and All Modules has no module predicate", async () => {
  const page = read("src/pages/admin/AdminAuditLogs.jsx");
  const stored = read("supabase_admin_audit_logs.sql");
  const visibleModules = [...page.match(/const canonicalModules = \[([\s\S]*?)\];/)[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]);
  check([...visibleModules].sort(), auditModules);
  for (const module of auditModules) check(stored.includes(`'${module}'`), true);

  const f = hookFixture({ mixedModules: true });
  await f.load();
  check(f.result.count, 24);
  check(f.queries.filter(query => query.some(op => op[0] === "range")).every(query => !query.some(op => op[0] === "eq" && op[1] === "module")), true);
  for (const module of auditModules) {
    f.setFilters({ module, page: 1 });
    await f.load();
    check(f.result.count, 3);
    check(f.result.rows.every(row => row.module === module), true);
    const pageQuery = f.queries.filter(query => query.some(op => op[0] === "range")).at(-1);
    check(pageQuery.some(op => op[0] === "eq" && op[1] === "module" && op[2] === module), true);
  }
  f.setFilters({ module: "all" });
  await f.load();
  check(f.result.count, 24);
  const allPage = f.queries.filter(query => query.some(op => op[0] === "range")).at(-1);
  check(allPage.some(op => op[0] === "eq" && op[1] === "module"), false);
  f.unmount();
});
for (const role of ["admin", "doctor", "staff", "patient"]) await scenario(`Role ${role} combines with existing filters in page and analytics reads`, async () => {
  const f = hookFixture({ mixedRoles: true }); await f.load();
  f.setFilters({ role, user: actorId, module: "authentication", action: "login", page: 1 });
  check(f.result.rows, [], "different role never displays cached all-role rows");
  const before = f.queries.length; await f.load();
  check(f.result.count, 6); check(f.result.analyticsRows.length, 6);
  check(f.result.rows.every(row => row.actor_role === role), true);
  for (const q of f.queries.slice(before)) {
    for (const [field, value] of [["actor_role", role], ["actor_user_id", actorId], ["module", "authentication"], ["action", "login"]]) {
      check(q.some(op => op[0] === "eq" && op[1] === field && op[2] === value), true);
    }
    check(q.some(op => op[0] === "gte" && op[1] === "created_at" && op[2] === "start"), true);
    check(q.some(op => op[0] === "lt" && op[1] === "created_at" && op[2] === "end"), true);
  }
  const refreshed = f.queries.length; await f.result.refresh(); f.render();
  check(f.queries.length - refreshed, 3, "one refresh reloads page, analytics and actors once");
  check(f.result.count, 6); check(f.result.rows.every(row => row.actor_role === role), true);
  f.setFilters({ role: "all" }); await f.load(); check(f.result.count, 24);
  check(f.result.analyticsRows.length, 24); f.unmount();
});
await scenario("Status filters the server page and exact count", async () => {
  const f = hookFixture(); await f.load();
  f.setFilters({ status: "reported", page: 1 });
  const before = f.queries.length; await f.load();
  check(f.result.count, 24); check(f.result.rows.length, 10);
  for (const query of f.queries.slice(before).filter(q => q.some(op => ["range", "limit"].includes(op[0])))) {
    check(query.some(op => op[0] === "eq" && op[1] === "status" && op[2] === "reported"), true);
  }
  f.setFilters({ status: "failure" }); await f.load();
  check(f.result.count, 0); check(f.result.rows, []);
  f.unmount();
});
await scenario("Audit pages retain stable newest-first ordering", async () => {
  const f = hookFixture(); await f.load();
  const page = f.queries.filter(q => q.some(op => op[0] === "range")).at(-1);
  check(page.filter(op => op[0] === "order"), [["order", "created_at", { ascending: false }], ["order", "id", { ascending: false }]]);
  check(f.queries.flat().some(op => op[0] === "ilike"), false);
  f.unmount();
});
await scenario("A late response for a previous role cannot populate the new role", async () => {
  const f = hookFixture({ mixedRoles: true }); await f.load();
  const late = deferred(); f.options.deferPage = late.promise; const first = f.result.refresh();
  await flush(); f.setFilters({ role: "patient" }); delete f.options.deferPage; await f.load();
  late.resolve(); await first; await flush(); f.render();
  check(f.result.count, 6); check(f.result.rows.every(row => row.actor_role === "patient"), true); f.unmount();
});
await scenario("Transient refresh failure exposes error and stale cache instead of silently succeeding", async () => {
  const f = hookFixture(); await f.load(); f.options.error = { code: "08006", message: "synthetic timeout" };
  await f.result.refresh(); f.render(); check(f.result.stale, true); check(f.result.canDisplay, true); check(f.result.rows.length, 10);
  check(f.result.error.code, "08006"); check(f.result.refreshing, false); f.unmount();
});
for (const options of [{ error: { code: "08006" } }, { error: { code: "42P01" } }, { emptyPage: true }]) {
  await scenario("Initial failed/incomplete response is not presented as an empty successful inbox", async () => {
    const f = hookFixture(options); await f.load(); check(Boolean(f.result.error), true); check(f.result.canDisplay, false);
    check(f.result.rows, []); check(f.result.pageLoading, false); f.unmount();
  });
}
await scenario("A verified empty result remains a valid fresh snapshot", async () => {
  const f = hookFixture({ count: 0 }); await f.load(); check(f.result.count, 0); check(f.result.rows, []);
  check(f.result.canDisplay, true); check(f.result.stale, false); f.unmount();
});
for (const code of ["42501", "PGRST301", "PGRST302", "PGRST303"]) await scenario(`Permission/auth error ${code} hides cached audit data`, async () => {
  const f = hookFixture(); await f.load(); f.options.error = { code }; await f.result.refresh(); f.render();
  check(f.result.canDisplay, false); check(f.result.rows, []); check(f.result.actorRows, []); check(f.cache.size, 0); f.unmount();
});
await scenario("Disabled Admin authorization never exposes snapshots or subscribes", async () => {
  const f = hookFixture(); await f.load(); f.disable(); check(f.result.rows, []); check(f.result.count, 0); check(f.result.canDisplay, false);
  check(f.channels.at(-1).removed, true); f.unmount();
});
await scenario("Private broadcast bursts coalesce; page one catches up on subscribe/reconnect", async () => {
  const f = hookFixture(); await f.load(); const channel = f.channels.at(-1); check(channel.config, { config: { private: true } });
  const before = f.queries.length; channel.status("SUBSCRIBED"); channel.receive(); channel.receive();
  f.fire(200); await flush(); f.render(); check(f.queries.length-before, 3);
  channel.status("CHANNEL_ERROR"); f.render(); check(Boolean(f.result.realtimeError), true);
  channel.status("SUBSCRIBED"); f.fire(200); await flush(); f.render(); check(f.result.realtimeError, ""); f.unmount();
});
await scenario("Older page stays still on new activity; manual refresh preserves offset", async () => {
  const f = hookFixture(); await f.load(); f.setFilters({ page: 2 }); await f.load(); const before = f.queries.length;
  f.channels.at(-1).receive(); f.fire(200); await flush(); f.render(); check(f.result.updatesAvailable, true); check(f.queries.length, before);
  await f.result.refresh(); f.render(); check(f.result.updatesAvailable, false); check(f.result.rows[0].id, "event-10"); f.unmount();
});
await scenario("Concurrent refresh requests schedule at most one trailing refresh", async () => {
  const f = hookFixture(); await f.load(); const pending = deferred(); f.options.deferPage = pending.promise;
  const before = f.queries.length; const first = f.result.refresh(); const second = f.result.refresh(); f.result.refresh();
  pending.resolve(); await Promise.all([first, second]); await flush(); f.render(); check(f.queries.length-before, 6); f.unmount();
});
await scenario("Late responses for old filters cannot overwrite a newly selected page", async () => {
  const f = hookFixture(); await f.load(); const pending = deferred(); f.options.deferPage = pending.promise;
  const first = f.result.refresh(); await flush(); f.setFilters({ page: 2 }); delete f.options.deferPage; await f.load();
  pending.resolve(); await first; await flush(); f.render(); check(f.result.rows[0].id, "event-10"); f.unmount();
});
await scenario("Details whitelist safe fields and distinguish reported, transactional and legacy rows", async () => {
  const legacy = getAuditEventDetails({ status: "success", previous_status: "diagnosis payload", request_id: "secret", metadata: { token: "must never render" } });
  check(legacy, [["Recorded Source", "Not recorded (legacy event)"], ["Request ID", "Not recorded"]]);
  const reported = getAuditEventDetails({ status: "reported", request_id: actorId }); check(reported[0][1], "Client reported (unverified)");
  const server = getAuditEventDetails({ audit_source: "server_transaction", previous_status: "active", new_status: "inactive" });
  check(server[0][1], "Server transaction (metadata marker)"); check(server.length, 4);
  check(hook.includes("audit_source:metadata->>event_source"), true); check(hook.includes(', metadata,'), false);
});
await scenario("Audit JSX retains warnings, filters, pagination and details without statistics or charts", async () => {
  const page = read("src/pages/admin/AdminAuditLogs.jsx");
  parse(page, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } }); assertions++;
  for (const text of ["Refresh failed. Showing previously loaded audit data.", "audit.actorTruncated", "audit.analyticsRows.map", "getAuditEventDetails(event)", "pageOutOfRange", "onViewDetails(row)", "onPageChange(safePage + 1)"]) check(page.includes(text), true);
  for (const text of ["Date Range", "All Users", "All Roles", "All Modules", "All Actions", "All Statuses", "Reset Filters", "Refresh", "Affected Record", "Event ID", "Actor ID", "audit.count === 0 ? (audit.error ? null", "Try a wider date range or clear the other filters."]) check(page.includes(text), true);
  for (const text of ["Sort by Date and Time", "Newest first", "Oldest first", "Search audit logs", "Search the selected field", "admin-audit-search", "submitSearch", "searchTerm", "searchField"]) check(page.includes(text), false);
  for (const text of ["Total Activity", "Authentication Events", "Account Access Changes", "Activities by Module", "Activities Over Time", "Charts summarize", "admin-audit-summary-grid", "admin-audit-chart-grid"]) check(page.includes(text), false);
});
for (const code of ["42703", "PGRST204"]) await scenario(`15-column production safely omits the optional origin: ${code}`, async () => {
  const f = hookFixture({ missingOrigin: code, cap: 3 }); await f.load();
  check(f.result.rows.length, 10); check(f.result.count, 24); check(f.result.error, null);
  const reads = f.queries.filter(q => q.some(op => op[0] === "range"));
  check(reads.length, 5); check(reads[0].find(op => op[0] === "select")[1].includes(", event_origin"), true);
  check(reads.slice(1).every(q => !q.find(op => op[0] === "select")[1].includes(", event_origin")), true);
  await f.result.refresh(); f.render(); check(f.result.canDisplay, true); f.unmount();
});
await scenario("16-column staging retains origin and counts client success without a status filter", async () => {
  const f = hookFixture({ staging: true }); await f.load();
  check(f.result.rows[0].event_origin, "client_reported"); check(f.result.rows[0].status, "success");
  check(getAuditEventDetails(f.result.rows[0])[0][1], "Client reported (unverified)");
  check(f.result.analyticsRows.length, 24); check(f.result.count, 24); check(f.queries.length, 3);
  check(f.queries.flat().some(op => op[0] === "eq" && op[1] === "status"), false); f.unmount();
});
for (const error of [{code:"42501",message:"event_origin permission denied"}, {code:"08006",message:"event_origin timeout"},
  {code:"42703",message:"column audit_logs.description does not exist"}, {code:"PGRST204",message:"Unknown other_column"}]) {
  await scenario(`Optional origin fallback preserves unrelated/auth/transport errors: ${error.code}`, async () => {
    const f = hookFixture({ error, errorPageOnly: true }); await f.load();
    check(f.result.error.code, error.code); check(f.result.canDisplay, false);
    check(f.queries.filter(q => q.some(op => op[0] === "range")).length, 1); f.unmount();
  });
}
await scenario("A missing-column error repeated on the base projection stops after one fallback", async () => {
  const f = hookFixture({ error: {code:"42703",message:"column event_origin does not exist"}, errorPageOnly:true }); await f.load();
  check(f.queries.filter(q => q.some(op => op[0] === "range")).length, 2); check(f.result.canDisplay, false); f.unmount();
});
await scenario("Empty RLS results clear cached older pages without treating an empty SELECT as permission proof", async () => {
  const f = hookFixture(); await f.load(); f.setFilters({page:2}); await f.load();
  f.options.count = 0; await f.result.refresh(); f.render();
  check(f.result.rows, []); check(f.result.analyticsRows, []); check(f.result.actorRows, []);
  check(f.result.count, 0); check(f.result.error, null); check(f.result.canDisplay, true);
  f.setFilters({page:1}); check(f.result.rows, []); check(f.result.canDisplay, false); await f.load();
  check(f.result.rows, []); f.unmount();
});
await scenario("Cached audit data is scoped to the authorized Admin identity", async () => {
  const f = hookFixture(); await f.load(); f.setAdmin("different-synthetic-admin");
  check(f.result.rows, []); check(f.result.actorRows, []); check(f.result.canDisplay, false);
  f.options.error = {code:"42501"}; await f.load(); check(f.result.rows, []); f.unmount();
});
await scenario("A single denied read blocks late cache writes and filter changes until a complete fresh refresh", async () => {
  const f = hookFixture(); await f.load(); f.setFilters({page:2}); await f.load();
  const late = deferred(); f.options.deferNonPage = late.promise;
  f.options.error = {code:"42501"}; f.options.errorPageOnly = true;
  const denied = f.result.refresh(); await flush(); f.render(); check(f.result.canDisplay, false);
  late.resolve(); await denied; f.render(); check(f.cache.size, 0); check(f.result.actorRows, []);
  delete f.options.deferNonPage; delete f.options.error;
  f.setFilters({page:1}); await f.load();
  check(f.result.canDisplay, false); check(f.result.rows, []); check(f.cache.size, 0);
  await f.result.refresh(); f.render(); check(f.result.canDisplay, true); check(f.result.rows.length,10);
  check(f.result.error,null); f.unmount();
});
for (const status of ["CHANNEL_ERROR","TIMED_OUT","CLOSED"]) await scenario(`Missing Realtime authorization preserves manual/focus refresh: ${status}`, async () => {
  const f = hookFixture(); await f.load(); f.channels.at(-1).status(status, new Error("synthetic join denial"));
  f.render(); check(Boolean(f.result.realtimeError), true); const before=f.queries.length;
  await f.result.refresh(); f.render(); check(f.queries.length-before,3); check(f.result.canDisplay,true); check(f.result.rows.length,10);
  f.event("window:focus"); f.fire(200); await flush(); f.render(); check(f.queries.length-before,6); f.unmount();
});
await scenario("Source classification keeps client success, unknown origins and legacy markers distinct", async () => {
  for (const [event,expected] of [
    [{status:"success",event_origin:"client_reported",audit_source:"server_transaction"},"Client reported (unverified)"],
    [{status:"success",event_origin:"server_verified",audit_source:"client_reported"},"Server verified"],
    [{status:"reported",event_origin:"server_verified"},"Conflicting source markers (unverified)"],
    [{status:"success",event_origin:"unexpected",audit_source:"server_transaction"},"Unrecognized source (unverified)"],
    [{status:"success",event_origin:null,audit_source:"client_reported"},"Client reported (unverified)"],
    [{status:"success"},"Not recorded (legacy event)"],
    [{status:"reported",audit_source:"server_transaction"},"Client reported (unverified)"]
  ]) check(getAuditEventDetails(event)[0][1], expected);
});
await scenario("Production proposal rejects staging and retains original definition/CHECK guards", async () => {
  check(sql.includes("<> 15"), true); check(sql.includes("attname='event_origin'"),true);
  check(sql.includes("to_regnamespace('s4audit_private') is not null"),true);
  check(sql.includes("Unexpected audit content CHECK"),true);
  check(/(?:create|alter|drop|grant|revoke)\s+[^;]*s4audit_private/i.test(sql),false);
  check(read("docs/sql-drafts/20261018_admin_audit_staging_tests.sql").includes("raise exception 'STOP: legacy test"), true);
});
console.log(`${scenarios} scenarios / ${assertions} assertions PASS; 0 failures. JavaScript mocks and SQL structural checks only; PostgreSQL authorization/rollback tests remain unexecuted staging gates.`);
