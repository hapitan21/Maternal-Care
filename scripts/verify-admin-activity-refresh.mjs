// Actual Dashboard hook with synthetic reads, hook state and private channels.
// No database, Auth session, provider or external network is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parse } from "espree";
import { adminAppointmentStatusDefinitions, mapAdminAuditActivity } from "../src/lib/adminDashboard.js";
import { formatAppointmentDate, formatAppointmentTime, getManilaDateKey, toManilaISOString } from "../src/lib/appointmentDate.js";

const source = fs.readFileSync(new URL("../src/hooks/useAdminDashboardData.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
let assertions = 0, scenarios = 0;
const check = (actual, expected) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected); assertions++; };
const scenario = async (name, run) => { await run(); scenarios++; console.log(`PASS ${name}`); };
const row = (id, module = "authentication", action = "login") => ({
  id, module, action, actor_name: "Synthetic Admin", actor_role: "admin",
  description: `${module} ${action}`, created_at: "2026-10-19T00:00:00Z",
});

function fixture(options = {}) {
  let cursor = 0, result, timerId = 0, adminId = "synthetic-admin", enabled = true, range = "month";
  const slots = [], effects = [], pending = [], cache = new Map(), timers = new Map();
  const channels = [], listeners = new Map(), queries = [];
  let activityReads = 0;
  options.rows ||= [row("login"), row("report", "reports", "export"), row("account", "user_management", "deactivate")];
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const eventTarget = prefix => ({
    addEventListener: (name, fn) => listeners.set(`${prefix}:${name}`, fn),
    removeEventListener: name => listeners.delete(`${prefix}:${name}`),
  });
  const context = vm.createContext({ console, adminAppointmentStatusDefinitions, mapAdminAuditActivity,
    formatAppointmentDate, formatAppointmentTime, getManilaDateKey,
    queryAdminOverdueScheduleRows: async () => ({ data: [], error: null }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useEffect: (fn, deps) => { const i = cursor++; if (!effects[i] || !equal(effects[i].deps, deps)) {
      effects[i]?.cleanup?.(); effects[i] = { deps }; pending.push(() => { effects[i].cleanup = fn(); }); } },
    window: { ...eventTarget("window"),
      setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
      setInterval: (fn, delay) => { timers.set(++timerId, { fn, delay, interval: true }); return timerId; }, clearInterval: id => timers.delete(id) },
    document: { ...eventTarget("document"), visibilityState: "visible" },
    getAdminWorkspaceSnapshot: (ns, id, key) => cache.get(`${ns}:${id}:${key}`),
    setAdminWorkspaceSnapshot: (ns, id, key, value) => cache.set(`${ns}:${id}:${key}`, value),
    clearAdminWorkspaceSnapshots: (ns, id) => { for (const key of cache.keys()) if (key.startsWith(`${ns}:${id}:`)) cache.delete(key); },
    supabase: {
      rpc: async name => {
        if (options.wait) await options.wait;
        if (name === "get_admin_dashboard_summary") return { data: { totals: { patients: 7 } }, error: options.summaryError || null };
        assert.equal(name, "admin_get_user_management_summary");
        return { data: { patients: { not_linked: 0 } }, error: null };
      },
      from: table => {
        assert.equal(table, "audit_logs"); const q = { operations: [] };
        for (const name of ["select", "order", "limit"]) q[name] = (...args) => { q.operations.push([name, ...args]); return q; };
        q.then = (resolve, reject) => {
          activityReads++; queries.push(q.operations);
          return (async () => {
            if (options.wait) await options.wait;
            if (options.throwError) throw options.throwError;
            return { data: options.rows.slice(0, 8), error: options.activityError || null };
          })().then(resolve, reject);
        }; return q;
      },
      channel: (name, config) => {
        const c = { name, config, on: (_type, _filter, receive) => { c.receive = receive; return c; }, subscribe: status => { c.status = status; return c; } };
        channels.push(c); return c;
      }, removeChannel: c => { c.removed = true; },
    },
  });
  vm.runInContext(source, context);
  const useHook = vm.runInContext("useAdminDashboardData", context);
  const render = () => { cursor = 0; result = useHook(range, enabled, adminId); pending.splice(0).forEach(fn => fn()); return result; };
  const fire = delay => { for (const [id, t] of [...timers]) if (t.delay === delay) { if (!t.interval) timers.delete(id); t.fn(); } };
  render();
  return { options, cache, channels, listeners, timers, queries, render, fire,
    get result() { return result; }, get reads() { return activityReads; },
    get audit() { return channels.filter(c => c.name === "admin:audit-logs" && !c.removed).at(-1); },
    load: async () => { fire(0); await flush(); return render(); },
    refresh: async () => { await result.refresh(); await flush(); return render(); },
    disable: () => { enabled = false; return render(); },
    changeRange: value => { range = value; return render(); },
    unmount: () => effects.forEach(e => e?.cleanup?.()),
  };
}

await scenario("Recent Activities presents persisted non-login events without filtering by action", async () => {
  const f = fixture(); await f.load();
  check(f.result.recentActivities.map(r => r.id), ["login", "report", "account"]);
  check(f.result.recentActivities[1].target, "reports");
  check(f.result.recentActivities[2].action, "Deactivate");
  check(f.queries[0].some(op => op[0] === "limit" && op[1] === 8), true); f.unmount();
});
await scenario("Private invalidation reloads actual rows; payload never fabricates an activity", async () => {
  const f = fixture(); await f.load(); check(f.audit.config, { config: { private: true } });
  f.options.rows.unshift(row("new-event", "appointment_management", "create"));
  f.audit.receive({ id: "forged-payload" }); await flush(); f.render();
  check(f.result.recentActivities[0].id, "new-event");
  check(f.result.recentActivities.some(r => r.id === "forged-payload"), false); f.unmount();
});
await scenario("Business-event invalidation uses the existing private channel and safe Dashboard projection", async () => {
  const f = fixture(); await f.load();
  f.options.rows = [{ ...row("staff-save", "visit_records", "create"),
    entity_type: "staff_initial_assessment", actor_role: "staff", description: "SENSITIVE synthetic note" }];
  f.audit.receive({ actor_role: "admin", description: "forged event" }); await flush(); f.render();
  check(f.result.recentActivities[0].description, "Staff Initial Assessment saved.");
  check(f.result.recentActivities[0].actorRole, "Staff");
  const projection = f.queries.at(-1).find(op => op[0] === "select")[1];
  check(projection.includes("entity_type"), true); check(projection.includes("metadata"), false);
  check(f.audit.config, { config: { private: true } }); f.unmount();
});
for (const code of ["42501", "PGRST301", "PGRST302", "PGRST303"]) await scenario(`Cached Dashboard activity is hidden on ${code}`, async () => {
  const f = fixture(); await f.load(); f.options.activityError = { code };
  await f.refresh(); check(f.result.recentActivities, []); check(f.result.activityError.code, code); check(f.cache.size, 0);
  delete f.options.activityError; f.options.summaryError = { code: "08006" };
  await f.refresh(); check(f.result.recentActivities, []); check(f.cache.size, 0);
  delete f.options.summaryError; await f.refresh(); check(f.result.recentActivities.length, 3); f.unmount();
});
await scenario("Disabled authorization hides all cached Dashboard data and removes subscriptions", async () => {
  const f = fixture(); await f.load(); f.disable(); check(f.result.recentActivities, []);
  check(f.result.totals.patients, 0); check(f.channels.every(c => c.removed), true); f.unmount();
});
await scenario("Realtime failure retains Refresh fallback and successful reconnect catches up", async () => {
  const f = fixture(); await f.load(); f.audit.status("CHANNEL_ERROR"); f.render();
  check(Boolean(f.result.realtimeError), true); const before = f.reads;
  f.options.rows = [row("report-only", "reports", "print")]; await f.refresh();
  check(f.reads, before + 1); check(f.result.recentActivities[0].id, "report-only");
  f.audit.status("SUBSCRIBED"); await flush(); f.render(); check(f.result.realtimeError, ""); f.unmount();
});
await scenario("Concurrent broadcasts coalesce into one in-flight and one trailing read", async () => {
  const f = fixture(); await f.load(); const hold = deferred(); f.options.wait = hold.promise;
  const before = f.reads; f.audit.receive(); f.audit.receive(); f.audit.receive();
  hold.resolve(); await flush(); await flush(); f.render(); check(f.reads - before, 2);
  check(new Set(f.result.recentActivities.map(r => r.id)).size, f.result.recentActivities.length); f.unmount();
});
await scenario("Cleanup removes channels, listeners and timers and ignores late broadcasts", async () => {
  const f = fixture(); await f.load(); const c = f.audit; const before = f.reads; f.unmount();
  check(f.channels.every(channel => channel.removed), true); check(f.timers.size, 0); check(f.listeners.size, 0);
  c.receive(); c.status("SUBSCRIBED"); await flush(); check(f.reads, before);
});

await scenario("Late requests cannot refill Dashboard snapshots after unmount", async () => {
  const f = fixture(); await f.load(); const hold = deferred(); f.options.wait = hold.promise;
  const pending = f.result.refresh(); await flush(); f.unmount(); f.cache.clear();
  hold.resolve(); await pending; check(f.cache.size, 0);
});

await scenario("Audit Logs retains date filters and pagination without removed analytics views", async () => {
  const page = fs.readFileSync(new URL("../src/pages/admin/AdminAuditLogs.jsx", import.meta.url), "utf8");
  const tree = parse(page, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } });
  const functions = ["addDays", "uniqueSorted", "pageNumbers"];
  const declarations = tree.body.filter(node => node.type === "FunctionDeclaration" && functions.includes(node.id.name))
    .map(node => page.slice(node.start, node.end));
  const context = vm.createContext({ getManilaDateKey });
  vm.runInContext(declarations.join("\n") + "\nglobalThis.helpers = {addDays, uniqueSorted, pageNumbers};", context);
  const start = toManilaISOString("2026-10-13", "00:00");
  const end = toManilaISOString(context.helpers.addDays("2026-10-19", 1), "00:00");
  check(start, "2026-10-12T16:00:00.000Z"); check(end, "2026-10-19T16:00:00.000Z");
  check(context.helpers.pageNumbers(1, 22), [1, 2, "ellipsis-22", 22]);
  check(context.helpers.pageNumbers(22, 22), [1, "ellipsis-21", 21, 22]);
  check(context.helpers.uniqueSorted(["reports", "authentication", "reports"]), ["authentication", "reports"]);
  for (const text of ["audit.analyticsRows.map", "count={audit.count}", "onPageChange={setPage}", "getAuditEventDetails(event)"]) check(page.includes(text), true);
  for (const text of ["Total Activity", "Authentication Events", "Account Access Changes", "Activities by Module", "Activities Over Time", "buildModuleItems", "buildTimeBuckets", "summaryCards"]) check(page.includes(text), false);
});
await scenario("Production diagnostic batch contains only read-only SELECT statements and known audit fields", async () => {
  const sql = fs.readFileSync(new URL("../docs/sql-drafts/admin-audit-production-readonly-diagnostics.sql", import.meta.url), "utf8");
  const text = sql.replace(/--[^\n]*/g, "");
  let stripped = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted; stripped += " ";
    } else if (!quoted) stripped += text[i];
  }
  check(quoted, false);
  const statements = stripped.split(";").map(s => s.trim()).filter(Boolean);
  check(statements.every(s => /^select\b/i.test(s)), true);
  check(/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|call|do|begin|commit|set|copy|execute)\b/i.test(stripped), false);
  check(/\b(net\.|dblink|pg_read_file|record_audit_event\s*\()/i.test(stripped), false);
  check(statements.length, 17);
  const schema = fs.readFileSync(new URL("../supabase_admin_audit_logs.sql", import.meta.url), "utf8")
    .match(/create table if not exists public\.audit_logs \(([\s\S]*?)\n\);/)[1];
  for (const name of ["id", "actor_user_id", "actor_role", "module", "action", "status", "metadata", "created_at"]) {
    check(new RegExp(`\\b${name}\\s+`).test(schema), true);
  }
});
console.log(`${scenarios} scenarios / ${assertions} assertions PASS; synthetic reads and SQL source checks only.`);
