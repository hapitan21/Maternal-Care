// Explicitly approved SMS-only rehearsal. No production URL, credentials or existing resource reuse.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { createClient as realClient } from "@supabase/supabase-js";

const root = fileURLToPath(new URL("../", import.meta.url));
const docker = "C:/Users/James Freian Hapitan/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe";
const socket = "npipe:////./pipe/dockerDesktopLinuxEngine";
const pgImage = "public.ecr.aws/supabase/postgres@sha256:5deba92e50cd17bfacf8603834d317cdf3bfc1c016ec8293991997fa3b55fa3d";
const restImage = "public.ecr.aws/supabase/postgrest@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df";
const read = p => fs.readFileSync(path.join(root, p), "utf8").replaceAll("\r\n", "\n");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const q = s => "'" + String(s).replaceAll("'", "''") + "'";
const id = () => crypto.randomUUID();
let liveNetworkAttempts = 0;
globalThis.fetch = () => { liveNetworkAttempts++; throw new Error("External HTTP is blocked in rehearsal"); };
registerHooks({ load(url, context, next) {
  if (url.startsWith("data:application/typescript;base64,")) return { format: "module", shortCircuit: true,
    source: stripTypeScriptTypes(Buffer.from(url.split(",")[1], "base64").toString(), { mode: "transform" }) };
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    assert(fileURLToPath(url).startsWith(path.join(root, "supabase", "functions") + path.sep));
    return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }) };
  }
  return next(url, context);
} });

function command(args, options = {}) {
  try { return execFileSync(docker, ["--host", socket, ...args], { encoding: "utf8", timeout: 30000,
    maxBuffer: 8e6, stdio: ["pipe", "pipe", "pipe"], ...options }).trim(); }
  catch (error) { const failure = new Error(`Docker ${args[0]} failed (private diagnostics retained in memory)`);
    failure.status = error.status; failure.privateStderr = String(error.stderr || ""); throw failure; }
}
function absent(type, name) {
  try { command([type, "inspect", name]); } catch (e) { assert(e.status === 1); return; }
  throw new Error("Resource collision; stop without modifying it");
}
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, "Reviewed SQL source section missing"); return source.slice(a, b);
}

async function main() {
  const args = process.argv.slice(2);
  const resumeEmpty = args[0] === "--resume-empty-fixture";
  const resume = args[0] === "--resume-unwritten-isolated" || resumeEmpty;
  assert(resume ? args.length === 2 : args.length === 1 && args[0] === "--execute-isolated", "Explicit isolated execution mode required");
  const prior = resume ? JSON.parse(fs.readFileSync(args[1], "utf8")) : null;
  if (resume) {
    assert.equal(prior.kind, "isolated-synthetic-sms-rehearsal");
    assert.match(prior.nonce, /^[a-f0-9]{24}$/);
    assert(resumeEmpty ? prior.identity && prior.tests.length === 1 && prior.status === "BLOCKED_OR_FAILED" : !prior.identity && prior.tests.length === 0,
      "Resume requires either an unwritten startup or an empty fixture database");
    assert.equal(path.resolve(args[1]), path.join(os.tmpdir(), `mc-sms-rehearsal-${prior.nonce}-results.json`));
  }
  const nonce = prior?.nonce ?? crypto.randomBytes(12).toString("hex"), prefix = `mc-sms-rehearsal-${nonce}`;
  const db = `${prefix}-db`, rest = `${prefix}-rest`, network = `${prefix}-net`, database = `mc_sms_${nonce}`;
  const resultFile = path.join(os.tmpdir(), `${prefix}-results.json`);
  const results = { kind: "isolated-synthetic-sms-rehearsal", nonce, db, rest, network, database,
    pgImage, restImage, tests: [], sourceHashes: {}, liveNetworkAttempts: 0, provider: "TEST_RECORDER_ONLY" };
  const saved = () => fs.writeFileSync(resultFile, JSON.stringify(results, null, 2) + "\n");
  const check = (condition, name) => { assert(condition, name); results.tests.push(name); };
  const existing = command(["ps", "-aq", "--no-trunc"]).split(/\s+/).filter(Boolean);
  assert.equal(command(["version", "--format", "{{.Server.Os}}"]), "linux");
  for (const image of [pgImage, restImage]) command(["image", "inspect", image, "--format", "{{.Id}}"]);
  if (!resume) { absent("network", network); absent("container", db); }
  absent("container", rest);
  for (const p of ["docs/sql-drafts/appointment-event-sms-control.sql", "supabase/functions/process-appointment-sms/index.ts",
    "supabase/functions/send-notification-sms/index.ts", "supabase/functions/_shared/appointmentSms.ts",
    "supabase/functions/_shared/appointmentEventSmsControl.ts"]) results.sourceHashes[p] = sha(read(p));
  saved();
  try {
    const inspect = name => JSON.parse(command(["inspect", name]))[0];
    const dbPassword = resume ? inspect(db).Config.Env.find(v => v.startsWith("POSTGRES_PASSWORD=")).slice("POSTGRES_PASSWORD=".length) : crypto.randomBytes(24).toString("hex");
    assert.match(dbPassword, /^[a-f0-9]{48}$/);
    if (!resume) {
    command(["network", "create", "--internal", "--driver", "bridge", "--label", `mc.sms.nonce=${nonce}`, network]);
    command(["run", "-d", "--pull=never", "--name", db, "--network", network, "--network-alias", "db",
      "--label", `mc.sms.nonce=${nonce}`, "--memory=512m", "--cpus=1", "--pids-limit=256",
      "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=384m", "--env", "POSTGRES_PASSWORD",
      "--env", "POSTGRES_DB=postgres", "--env", "POSTGRES_USER=supabase_admin", pgImage,
      "postgres", "-D", "/etc/postgresql", "-c", `cluster_name=${prefix}`, "-c", "listen_addresses=*",
      // This pinned image's supautils session hook SIGSEGVs on even a trivial SQL
      // function EXECUTE denial (bounded A/B probe). Keep native Vault/shared
      // extensions and all grants; omit only that hook in this disposable runtime.
      "-c", "session_preload_libraries="],
    { env: { ...process.env, POSTGRES_PASSWORD: dbPassword } });
    }
    const assertContainer = (name, image) => {
      const c = inspect(name);
      assert.equal(c.Config.Labels["mc.sms.nonce"], nonce); assert.equal(c.Config.Image, image);
      assert(!existing.includes(c.Id) || resume && name === db); assert.equal(c.HostConfig.Privileged, false);
      assert.equal(c.HostConfig.NetworkMode, network); assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [network]);
      assert(Object.values(c.HostConfig.PortBindings || {}).every(v => !v?.length));
      assert(Object.values(c.NetworkSettings.Ports || {}).every(v => !v?.length));
      assert(c.Mounts.every(m => m.Type === "tmpfs")); assert(!c.HostConfig.Binds?.length);
      if (name === db) assert.deepEqual(Object.keys(c.HostConfig.Tmpfs), ["/var/lib/postgresql/data"]);
      return c;
    };
    const n = JSON.parse(command(["network", "inspect", network]))[0];
    assert(n.Internal && n.Driver === "bridge" && n.Labels["mc.sms.nonce"] === nonce);
    assertContainer(db, pgImage);
    assert(command(["exec", db, "cat", "/proc/mounts"]).split("\n").some(line => /^tmpfs \/var\/lib\/postgresql\/data tmpfs /.test(line)), "Fresh database must actually use tmpfs");
    const sqlRaw = (text, target = database, user = 'postgres') => command(["exec", "-i", "-u", "postgres", "--env", `PGPASSWORD=${dbPassword}`, db, "psql", "-X", "-qAt",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-U", "supabase_admin", "-d", target], { input: (user === 'postgres' ? "set role postgres;\n" : "") + text });
    let ready = false;
    for (let i = 0; i < 45; i++) { try { if (sqlRaw("select current_setting('listen_addresses');", 'postgres', 'supabase_admin') === '*') { ready = true; break; } } catch { /* Wait only for this new database. */ } await sleep(500); }
    assert(ready, "Fresh PostgreSQL startup failed; do not fall back to another database");
    const identity = JSON.parse(sqlRaw("select json_build_object('db',current_database(),'cluster',current_setting('cluster_name'),'version',current_setting('server_version_num'),'user',current_user,'session_preload',current_setting('session_preload_libraries'),'vault_available',exists(select 1 from pg_available_extensions where name='supabase_vault'));", 'postgres', 'supabase_admin'));
    assert.equal(identity.db, 'postgres'); assert.equal(identity.cluster, prefix); assert.equal(identity.user, "supabase_admin");
    assert(String(identity.version).startsWith("170006")); assert(identity.vault_available, "Native Supabase Vault unavailable");
    assert.equal(identity.session_preload, "", "Reject the known-crashing image session hook before fixture writes");
    assert.equal(sqlRaw(`select exists(select 1 from pg_database where datname=${q(database)});`, 'postgres', 'supabase_admin'), resumeEmpty ? 't' : 'f', "Unexpected test database state");
    if (resumeEmpty) assert.equal(sqlRaw("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','vault','sms_rehearsal');"), '0', "Never resume populated fixtures");
    results.identity = identity; check(true, "fresh DB/cluster/image/network/no-port/no-shared-mount identity verified BEFORE fixture writes");
    if (!resumeEmpty) sqlRaw(`create database ${database} owner postgres;`, 'postgres', 'supabase_admin');
    assert.equal(sqlRaw("select current_database();"), database);
    command(["exec", db, "curl", "--version"]);
    const sql = text => { assertContainer(db, pgImage); return sqlRaw(text); };
    const json = text => JSON.parse(sql(text));
    const adminSql = text => { assertContainer(db, pgImage); return sqlRaw(text, database, 'supabase_admin'); };
    const dbFailure = (text, code, admin = false) => {
      try { (admin ? adminSql : sql)(text); } catch (e) { assert(e.privateStderr.includes(code), `Expected PostgreSQL SQLSTATE ${code}`); return; }
      throw new Error("Expected permission/read failure did not occur");
    };
    const restPassword = crypto.randomBytes(24).toString("hex"), jwtKey = crypto.randomBytes(32).toString("hex");
    // Bootstrap privileged extension/roles as the native local superuser. API
    // calls and the unchanged SECURITY DEFINER helper still use their real roles.
    adminSql(`create extension if not exists supabase_vault cascade;
      do $roles$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        if not exists(select 1 from pg_roles where rolname='sms_authenticator') then create role sms_authenticator login noinherit; end if;
      end $roles$;
      alter role sms_authenticator password ${q(restPassword)};
      grant anon,authenticated,service_role to sms_authenticator;
      grant usage on schema public to anon,authenticated,service_role;
      grant usage on schema vault to postgres;
      grant select on vault.decrypted_secrets to postgres;
      grant execute on function vault._crypto_aead_det_decrypt to postgres;`);
    sql(`
      create schema sms_rehearsal;
      create table sms_rehearsal.identity(nonce text primary key);
      insert into sms_rehearsal.identity values(${q(nonce)});
      create table public.profiles(id uuid primary key,role text not null,account_status text not null);
      create table public.patients(id uuid primary key,contact_number text);
      create table public.schedule(id uuid primary key,patient_id uuid references public.patients(id),doctor_id uuid,
        title text,description text,start_time timestamptz,end_time timestamptz,status text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table public.patient_notifications(id uuid primary key);
      create table public.medication_reminders(id uuid primary key);
      create table public.medication_reminder_occurrences(id uuid primary key);
      create table public.appointment_events(id uuid primary key,schedule_id uuid,patient_id uuid,event_type text,
        previous_start_time timestamptz,previous_end_time timestamptz,new_start_time timestamptz,new_end_time timestamptz,created_at timestamptz default now());`);
    const ledgerSource = read("supabase/migrations/20260922170000_notification_dispatch_idempotency_phase1.sql");
    sql(section(ledgerSource, "create table public.notification_dispatches (", "notify pgrst, 'reload schema';"));
    const retrySource = read("supabase/migrations/20260923160000_notification_dispatch_reconciliation_phase5.sql");
    sql(section(retrySource, "create or replace function public.classify_notification_dispatch(", "notify pgrst, 'reload schema';"));
    sql(read("docs/sql-drafts/appointment-event-sms-control.sql"));
    results.vault = json("select json_build_object('version',extversion,'schema',extnamespace::regnamespace::text) from pg_extension where extname='supabase_vault';");
    const setting = value => {
      adminSql("delete from vault.secrets where name='appointment_event_sms_enabled';");
      if (value !== undefined) adminSql(`select vault.create_secret(${q(value)},'appointment_event_sms_enabled','Synthetic rehearsal only');`);
    };
    const enabled = () => sql("set role service_role; select public.is_appointment_event_sms_enabled();");
    for (const [label, value, expected] of [["missing", undefined, "f"], ["false", "false", "f"], ["exact true", "true", "t"],
      ["invalid", "garbage", "f"], ["whitespace", " true ", "f"], ["case", "TRUE", "f"], ["JSON text", '{"enabled":true}', "f"]]) {
      setting(value); check(enabled() === expected, `native Vault RPC ${label}`);
    }
    setting("true");
    dbFailure("select vault.create_secret('true','appointment_event_sms_enabled','Duplicate synthetic setting');", "23505", true);
    check(true, "native Vault uniqueness rejects duplicate setting names");
    check(sql("select coalesce(count(*)=1 and bool_and(v='true'),false) from (values('true'),('true')) x(v);") === "f", "SQL cardinality guard rejects duplicate input");
    for (const role of ["anon", "authenticated"]) {
      dbFailure(`set role ${role}; select public.is_appointment_event_sms_enabled();`, "42501");
      dbFailure(`set role ${role}; select decrypted_secret from vault.decrypted_secrets;`, "42501");
      check(true, `${role}: native RPC and Vault access denied`);
    }
    const permissions = json("select json_build_object('owner',pg_get_userbyid(proowner),'definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',oid,'EXECUTE'),'service',has_function_privilege('service_role',oid,'EXECUTE')) from pg_proc where oid='public.is_appointment_event_sms_enabled()'::regprocedure;");
    check(permissions.owner === "postgres" && permissions.definer && permissions.config.includes('search_path=""') && !permissions.anon && !permissions.authenticated && permissions.service, "native helper owner/search_path/effective grants");
    results.permissions = permissions;
    sql("grant select on public.profiles,public.patients,public.schedule,public.appointment_events to service_role;");
    const staff = id(), doctor = id(), patient = id(), secondPatient = id();
    sql(`insert into public.profiles values(${q(staff)},'staff','active'),(${q(doctor)},'doctor','active'),(${q(patient)},'patient','active');
      insert into public.patients values(${q(patient)},'09171234567'),(${q(secondPatient)},'09171234568');`);
    adminSql(`
      select vault.create_secret('false','appointment_sms_bridge_enabled','Synthetic OFF');
      select vault.create_secret('false','medication_sms_bridge_enabled','Synthetic OFF');`);
    const jwt = (role, sub = id()) => {
      const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
      const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, sub, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
      return `${body}.${crypto.createHmac("sha256", jwtKey).update(body).digest("base64url")}`;
    };
    command(["run", "-d", "--pull=never", "--name", rest, "--network", network, "--network-alias", "rest",
      "--label", `mc.sms.nonce=${nonce}`, "--memory=192m", "--cpus=1", "--pids-limit=128", "--read-only",
      "--env", "PGRST_DB_URI", "--env", "PGRST_JWT_SECRET", "--env", "PGRST_DB_SCHEMAS=public",
      "--env", "PGRST_DB_ANON_ROLE=anon", "--env", "PGRST_SERVER_PORT=3000", restImage],
    { env: { ...process.env, PGRST_DB_URI: `postgres://sms_authenticator:${restPassword}@db:5432/${database}`, PGRST_JWT_SECRET: jwtKey } });
    assertContainer(rest, restImage);
    const serviceJwt = jwt("service_role");
    const http = async (url, options = {}) => {
      const parsed = new URL(typeof url === "string" ? url : url.url);
      assert.equal(parsed.origin, "http://rest:3000", "HTTP destination must be the nonce-owned internal PostgREST");
      const headers = new Headers(options.headers), args = ["exec", "-i", db, "curl", "--noproxy", "*", "-sS", "--max-time", "8",
        "-X", options.method || "GET", "-w", "\n%{http_code}"];
      for (const [k,v] of headers) args.push("-H", `${k}: ${v}`);
      if (options.body !== undefined) args.push("--data-binary", "@-"); args.push(parsed.href);
      const output = await new Promise((resolve, reject) => {
        const child = spawn(docker, ["--host", socket, ...args], { stdio: ["pipe", "pipe", "pipe"] });
        let out = ""; child.stdout.on("data", c => { out += c; }); child.stderr.resume();
        child.on("error", () => reject(new Error("Isolated HTTP execution failed")));
        child.on("close", code => code === 0 ? resolve(out) : reject(new Error("Isolated HTTP request failed")));
        child.stdin.end(options.body === undefined ? "" : String(options.body));
      });
      const split = output.lastIndexOf("\n"), status = Number(output.slice(split + 1));
      return new Response(status === 204 ? null : output.slice(0, split), { status, headers: { "content-type": "application/json" } });
    };
    const rpcHttp = token => http("http://rest:3000/rpc/is_appointment_event_sms_enabled", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    let apiReady = false;
    for (let i = 0; i < 35; i++) { try { const r = await rpcHttp(serviceJwt); if (r.status === 200) { apiReady = true; break; } } catch { /* Fresh service may still be starting. */ } await sleep(400); }
    assert(apiReady, "Fresh PostgREST service-role RPC unavailable");
    check(await (await rpcHttp(serviceJwt)).json() === true, "real PostgREST service-role boolean response");
    for (const role of ["anon", "authenticated"]) { const r = await rpcHttp(jwt(role)); check([401,403,404].includes(r.status), `${role}: real PostgREST denial`); }
    setting(undefined); check(await (await rpcHttp(serviceJwt)).json() === false, "PostgREST absent setting OFF");
    const secret = "sb_secret_" + crypto.randomBytes(24).toString("hex");
    const userTokens = new Map([[jwt("authenticated", staff), staff], [jwt("authenticated", doctor), doctor], [jwt("authenticated", patient), patient]]);
    const tokenFor = actor => [...userTokens].find(([,sub]) => sub === actor)[0];
    let afterPatientRead = null;
    const client = () => {
      const actual = realClient("http://rest:3000", serviceJwt, { auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: async (url, opts) => {
          const response = await http(String(url), opts);
          if (afterPatientRead && new URL(String(url)).pathname === "/patients") { const hook = afterPatientRead; afterPatientRead = null; hook(); }
          return response;
        } } });
      // PostgREST runs at root in this environment; retain the actual SDK/query implementation.
      actual.rest.url = "http://rest:3000";
      actual.auth.getUser = token => Promise.resolve({ data: { user: userTokens.has(token) ? { id: userTokens.get(token) } : null }, error: userTokens.has(token) ? null : new Error("Synthetic Auth denial") });
      return actual;
    };
    const runtime = { createClient: client,
      deno: { env: { get: key => key === "SUPABASE_URL" ? "http://rest:3000" : key === "SUPABASE_SECRET_KEY" ? secret : undefined }, serve() {} },
      console: { info() {}, error() {} } };
    const { sendIprogSms } = await import(pathToFileURL(path.join(root, "supabase/functions/_shared/iprogSms.ts")).href);
    const recorder = [];
    runtime.sendIprogSms = input => sendIprogSms(input, { readEnvironment: key => key === "IPROGSMS_API_TOKEN" ? "synthetic-recorder-only" : undefined,
      fetch: async (url, request) => { assert.equal(url, "https://www.iprogsms.com/api/v1/sms_messages");
        const data = JSON.parse(request.body); assert.equal(data.api_token, "synthetic-recorder-only");
        assert(!/[^\x20-\x7e]/.test(data.message)); recorder.push({ phone: data.phone_number, message: data.message });
        return Response.json({ status: 200, message_id: `test-recorder-${recorder.length}` }); } });
    const load = async (relative, transport) => {
      let callback; const key = "sms_isolated_" + id();
      const context = { ...runtime, deno: { ...runtime.deno, serve: value => { callback = value; } } };
      context.fetch = async (url, request) => {
        assert.equal(url, "http://rest:3000/functions/v1/send-notification-sms");
        return transport(new Request(url, request));
      };
      globalThis[key] = context;
      let source = read(relative).replace('import { createClient, type SupabaseClient } from "@supabase/supabase-js";', "")
        .replace(/ {2}sendIprogSms,\r?\n/, "")
        .replace(/from "(\.\.[^"]+)"/g, (_m,p) => `from "${new URL(p, pathToFileURL(path.join(root, relative))).href}"`)
        .replaceAll("Deno.", "_runtime.deno.").replace(/\bfetch\(/g, "_runtime.fetch(");
      source = `const _runtime=globalThis[${JSON.stringify(key)}];const createClient=_runtime.createClient;type SupabaseClient=ReturnType<typeof createClient>;const console=_runtime.console;const sendIprogSms=_runtime.sendIprogSms;\n` + source;
      try { await import(`data:application/typescript;base64,${Buffer.from(source).toString("base64")}`); } finally { delete globalThis[key]; }
      assert.equal(typeof callback, "function"); return callback;
    };
    const transport = await load("supabase/functions/send-notification-sms/index.ts");
    const orchestrator = await load("supabase/functions/process-appointment-sms/index.ts", transport);
    const call = (actor, scheduleId, event = "appointment_confirmed", extra = {}) => orchestrator(new Request("http://isolated.test/appointment-sms", {
      method: "POST", headers: { authorization: `Bearer ${tokenFor(actor)}`, "content-type": "application/json" },
      body: JSON.stringify({ event, schedule_id: scheduleId, ...extra }) }));
    const createAppointment = () => { const scheduleId = id(); sql(`insert into public.schedule values(${q(scheduleId)},${q(patient)},${q(doctor)},'Synthetic',null,'2026-10-21 00:00Z','2026-10-21 00:30Z','scheduled',now(),now());`); return scheduleId; };
    const count = () => Number(sql("select count(*) from public.notification_dispatches;"));
    const histories = id(); sql(`insert into public.notification_dispatches(id,dispatch_key,patient_id,channel,notification_type,status,provider,last_error) values(${q(histories)},'synthetic-legacy-history',${q(patient)},'sms','appointment_confirmed','failed','semaphore','synthetic_history');`);
    const historyBefore = sql(`select row_to_json(d)::text from public.notification_dispatches d where id=${q(histories)};`);
    for (const on of [false,true]) {
      setting(on ? "true" : "false");
      for (const [label, actor] of [["Staff initial appointment",staff],["Staff Add Appointment",staff],["Doctor Add Appointment",doctor],["Staff booking approval accepted persistence",staff]]) {
        const scheduleId = createAppointment(), before = recorder.length;
        const r = await call(actor, scheduleId), body = await r.json();
        check(r.status === 200 && (on ? body.sent === true : body.skipped === true), `${label}: ${on ? "ON recorder" : "OFF suppressed"}`);
        check(recorder.length === before + Number(on), `${label}: expected recorder call count`);
        const retry = await call(actor, scheduleId); check(retry.status === 200 && recorder.length === before + Number(on), `${label}: retry no duplicate`);
      }
      for (const actor of [staff,doctor]) {
        const scheduleId = createAppointment(), eventId = id();
        sql(`update public.schedule set start_time='2026-10-22 01:00Z',end_time='2026-10-22 01:30Z' where id=${q(scheduleId)};
          insert into public.appointment_events values(${q(eventId)},${q(scheduleId)},${q(patient)},'appointment_rescheduled','2026-10-21 00:00Z','2026-10-21 00:30Z','2026-10-22 01:00Z','2026-10-22 01:30Z',now());`);
        let before = recorder.length;
        const r = await call(actor, scheduleId, "appointment_rescheduled", { appointment_event_id: eventId });
        check(r.status === 200 && recorder.length === before + Number(on), `${actor === staff ? "Staff" : "Doctor"} reschedule ${on ? "ON" : "OFF"}`);
        if (on) check(recorder.at(-1).message.includes("Oct 21, 2026 at 8:00 AM") && recorder.at(-1).message.includes("Oct 22, 2026 at 9:00 AM"), "persisted old/new Manila ASCII reschedule times");
        sql(`update public.schedule set status='cancelled' where id=${q(scheduleId)};`); before = recorder.length;
        const c = await call(actor, scheduleId, "appointment_cancelled");
        check(c.status === 200 && recorder.length === before + Number(on), `${actor === staff ? "Staff" : "Doctor"} cancellation ${on ? "ON" : "OFF"}`);
      }
    }
    setting("true");
    const denied = createAppointment(), beforeDenied = recorder.length, ledgerBefore = count();
    check((await call(patient, denied)).status === 403 && count() === ledgerBefore, "Patient cannot request appointment SMS");
    sql(`update public.schedule set doctor_id=${q(staff)} where id=${q(denied)};`);
    check((await call(doctor, denied)).status === 403 && recorder.length === beforeDenied, "foreign Doctor cannot claim/send");
    const missing = await call(staff, id()); check(missing.status === 404 && recorder.length === beforeDenied, "failed appointment lookup never sends");
    const concurrent = createAppointment(), beforeConcurrent = recorder.length;
    await Promise.all([call(staff, concurrent),call(staff, concurrent)]);
    check(recorder.length === beforeConcurrent + 1, "concurrent genuine PostgreSQL dispatch claims yield one recorder request");
    const rawId = id(); sql(`insert into public.notification_dispatches(id,dispatch_key,patient_id,channel,notification_type,status) values(${q(rawId)},${q('raw-'+rawId)},${q(patient)},'sms','appointment_confirmed','processing');`);
    const rawRequest = dispatchId => new Request("http://isolated.test/transport", { method:"POST",headers:{apikey:secret,"content-type":"application/json"},body:JSON.stringify({dispatch_id:dispatchId,message:"Maternal Care: Oct 21, 2026 at 8:00 AM"}) });
    const beforeRaw = recorder.length; await Promise.all([transport(rawRequest(rawId)),transport(rawRequest(rawId))]);
    check(recorder.length === beforeRaw + 1, "concurrent genuine PostgreSQL provider-null CAS yields one recorder request");
    const queued = createAppointment(), beforeQueue = recorder.length;
    afterPatientRead = () => setting("false");
    const queueResponse = await call(staff, queued);
    check(queueResponse.status === 200 && recorder.length === beforeQueue, "queued event OFF after reservation suppresses provider");
    const queuedId = sql(`select id from public.notification_dispatches where related_schedule_id=${q(queued)};`);
    check(sql(`select status from public.notification_dispatches where id=${q(queuedId)};`) === "cancelled", "queued event terminal cancellation persisted");
    const retryRow = json(`select row_to_json(r) from public.claim_notification_dispatch_retry(${q(queuedId)},${q('appointment:'+queued+':confirmed:sms')}) r;`);
    check(!retryRow.may_send, "cancelled dispatch cannot be claimed by real retry RPC");
    setting("true"); await call(staff, queued); check(recorder.length === beforeQueue, "switch ON never automatically replays a suppressed event");
    const readError = createAppointment(), beforeError = recorder.length;
    adminSql("alter view vault.decrypted_secrets rename to decrypted_secrets_rehearsal_unavailable;");
    try { const r = await call(staff, readError); check(r.status === 200 && recorder.length === beforeError, "native Vault read failure fails closed at actual transport"); }
    finally { adminSql("alter view vault.decrypted_secrets_rehearsal_unavailable rename to decrypted_secrets;"); }
    check(sql(`select row_to_json(d)::text from public.notification_dispatches d where id=${q(histories)};`) === historyBefore, "legacy Semaphore history preserved byte-for-byte");
    check(sql("select bool_and(decrypted_secret='false') from vault.decrypted_secrets where name in ('appointment_sms_bridge_enabled','medication_sms_bridge_enabled');") === "t", "both independent reminder bridge settings remain OFF");
    check(liveNetworkAttempts === 0, "zero external network/provider requests");
    assertContainer(db, pgImage); assertContainer(rest, restImage);
    const finalNetwork = JSON.parse(command(["network","inspect",network]))[0];
    assert.equal(Object.keys(finalNetwork.Containers).length,2);
    check(existing.every(containerId => command(["ps","-aq","--no-trunc"]).split(/\s+/).includes(containerId)), "all pre-existing container identities preserved");
    results.providerRecorderCalls = recorder.length; results.dispatchRows = count(); results.liveNetworkAttempts = liveNetworkAttempts;
    results.workflowLimitation = "Synthetic persistence fixtures, not production registration/scheduling RPC replay; Auth getUser fixture, real PostgREST service JWT and actual guarded SMS handlers.";
    results.status = "PASS"; saved();
    console.log(JSON.stringify({ status:results.status, tests:results.tests.length, database:database, db, rest, network,
      postgres:identity.version, vault:results.vault, providerRecorderCalls:recorder.length, liveNetworkAttempts, results:resultFile }));
  } catch (error) {
    results.status = "BLOCKED_OR_FAILED"; results.failure = { name:error.name, message:error.message };
    // Never serialize SQL inputs, generated credentials or raw database/HTTP error bodies.
    saved(); console.error(JSON.stringify({ status:results.status, failure:results.failure, results:resultFile })); throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
