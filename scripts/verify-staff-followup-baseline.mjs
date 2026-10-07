// Offline: node scripts/verify-staff-followup-baseline.mjs --pglite <local dist/index.js>
// PGlite is optional for frontend checks; SQL checks use only an in-memory fixture.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { parse } from "espree";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import * as dates from "../src/lib/appointmentDate.js";
import * as clinical from "../src/lib/clinicalVisitData.js";

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const root = new URL("../", import.meta.url);
const formPath = "src/pages/appointments/StaffPreConsultationForm.jsx";
const migrationPath = "supabase/migrations/20261007120000_fix_staff_followup_pregnancy_baseline.sql";
const source = await readFile(new URL(formPath, root), "utf8");
const migration = await readFile(new URL(migrationPath, root), "utf8");
const ast = text => parse(text, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    const result = child && typeof child === "object" ? find(child, predicate) : null;
    if (result) return result;
  }
  return null;
}
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function check(ok, message) { assert.ok(ok, message); checks++; }
const names = ["toInputDate", "createFormDefaults", "parseGestationalAgeToDays", "parseDateKeyToUtc", "progressGestationalAge",
  "buildPreviousDoctorVisitDefaults", "normalizePregnancyRisk", "normalizeLoadedForm", "RiskSelector", "DateField"];
const declarations = ast(source).body.filter(node => node.type === "FunctionDeclaration" && names.includes(node.id.name) ||
  node.type === "VariableDeclaration" && node.declarations.some(item => ["initialFields", "followUpFields", "pregnancyStatusOptions"].includes(item.id.name)));
const context = vm.createContext({ ...dates, ...clinical, Date, Calendar: () => null });
const code = (await transformWithOxc(declarations.map(node => source.slice(...node.range)).join("\n") +
  "\nexport { normalizeLoadedForm, buildPreviousDoctorVisitDefaults, RiskSelector, DateField };", "fixture.jsx", { jsx: { runtime: "automatic", development: false } })).code;
const module = new vm.SourceTextModule(code, { context });
await module.link(() => new vm.SyntheticModule(Object.keys(jsxRuntime), function () {
  for (const [key, value] of Object.entries(jsxRuntime)) this.setExport(key, value);
}, { context }));
await module.evaluate();
const { normalizeLoadedForm, buildPreviousDoctorVisitDefaults, RiskSelector, DateField } = module.namespace;
const appointment = { start_time: "2026-10-07T02:00:00Z" };
const baseline = { gestational_age: "27", expected_delivery_date: "2027-01-06", pregnancy_status: "Low Risk" };
const vitals = ["bloodPressure", "temperature", "weight", "fetalHeartRate", "respiratoryRate", "oxygenSaturation"];
function verifyUi(form, expectedEdd, expectedRisk) {
  equal(form.gestationalAge, "27", "Doctor GA 27 retained");
  equal(form.expectedDeliveryDate, expectedEdd, "EDD ISO date input value");
  equal(form.pregnancyStatus, expectedRisk, "canonical risk selector value");
  const dateHtml = renderToStaticMarkup(React.createElement(DateField, { label: "Expected Delivery Date", value: form.expectedDeliveryDate, onChange() {} }));
  check(dateHtml.includes('type="date"') && dateHtml.includes(`value="${expectedEdd}"`), "actual date input renders EDD");
  const riskHtml = renderToStaticMarkup(React.createElement(RiskSelector, { value: form.pregnancyStatus, onChange() {} }));
  if (expectedRisk) check(riskHtml.includes(`class="is-active">${expectedRisk}</button>`), "actual risk button visibly selected");
  else equal((riskHtml.match(/is-active/g) || []).length, 0, "unknown risk leaves selector unselected");
}
for (const value of ["", null, undefined, " \t\r\n", "-", "Not provided", "Not recorded", "n/a", "NA", "none", "null", "undefined"]) {
  const input = { intake_data: { expectedDeliveryDate: value, pregnancyStatus: value } };
  const before = JSON.stringify(input);
  const form = normalizeLoadedForm("follow_up", appointment, input, baseline);
  verifyUi(form, "2027-01-06", "Low Risk");
  for (const key of vitals) equal(form[key], "", "new current-visit vital stays blank: " + key);
  equal(JSON.stringify(input), before, "prefill does not mutate/save intake");
}
for (const [value, expected] of [["low", "Low Risk"], [" low-risk ", "Low Risk"], ["LOW   RISK", "Low Risk"],
  ["Moderate_Risk", "Moderate Risk"], ["HIGH - RISK", "High Risk"]]) {
  const data = buildPreviousDoctorVisitDefaults({ ...baseline, riskLevel: value }, appointment);
  equal(data.pregnancyStatus, expected, "current Doctor riskLevel normalized: " + value);
}
for (const key of ["pregnancyStatus", "pregnancy_status"]) {
  const data = buildPreviousDoctorVisitDefaults({ gestational_age: "27", [key]: "low risk" }, appointment);
  equal(data.pregnancyStatus, "Low Risk", "legacy risk compatibility: " + key);
}
const savedIntake = { intake_data: { expectedDeliveryDate: "2027-01-08", pregnancyStatus: "high-risk", bloodPressure: "120/80" } };
const saved = normalizeLoadedForm("follow_up", appointment, savedIntake, baseline);
verifyUi(saved, "2027-01-08", "High Risk");
equal(saved.bloodPressure, "120/80", "same-appointment Staff measurements preserved on edit");
const noBaseline = normalizeLoadedForm("follow_up", appointment, null, null);
equal(noBaseline.expectedDeliveryDate, "", "absent EDD stays blank");
equal(noBaseline.pregnancyStatus, "", "absent risk stays blank");
const progressed = normalizeLoadedForm("follow_up", { start_time: "2026-10-14T02:00:00Z" }, { intake_data: { gestationalAge: "20" } }, {
  ...baseline, gestational_age_anchor: "27", gestational_age_anchor_date: "2026-10-07" });
equal(progressed.gestationalAge, "28 weeks", "existing GA anchor recalculation remains authoritative");
const previousVitals = { ...baseline, bloodPressure: "110/70", temperature: "36.7", weight: "58", fetalHeartRate: "145", respiratoryRate: "18", oxygenSaturation: "98" };
const fresh = normalizeLoadedForm("follow_up", appointment, null, previousVitals);
for (const key of vitals) equal(fresh[key], "", "previous Doctor vital never copied: " + key);
const initial = normalizeLoadedForm("initial", appointment, savedIntake, baseline);
equal(initial.expectedDeliveryDate, "2027-01-08", "Initial merge behavior unchanged");
equal(initial.pregnancyStatus, "high-risk", "Initial normalization untouched");
const head = execFileSync("git", ["show", "HEAD:" + formPath], { cwd: root, encoding: "utf8" });
for (const name of ["saveForm", "loadForm", "progressGestationalAge", "RiskSelector", "DateField", "validateStaffIntake"]) {
  const select = text => {
    const node = find(ast(text), item => (item.type === "VariableDeclarator" || item.type === "FunctionDeclaration") && item.id?.name === name);
    return text.slice(...node.range).replace(/\r\n/g, "\n");
  };
  equal(select(source), select(head), "existing workflow/UI function unchanged: " + name);
}
const fromTables = [...source.matchAll(/\.from\("([^"]+)"\)/g)].map(match => match[1]);
equal(fromTables, ["schedule"], "no new direct frontend Patient/clinical table reads");
check(source.includes('supabase.rpc("get_staff_followup_baseline"'), "authorized baseline RPC remains the data source");
check(!/\b(?:alter\s+table|create\s+table|create\s+policy|grant\s|revoke\s|drop\s+function)\b/i.test(migration.replace(/--[^\n]*/g, "")), "migration adds no tables, policies or privilege changes");
check(migration.includes("pg_catalog.pg_get_functiondef(v_function)") && migration.includes("v_after is distinct from v_before"), "installed signature/GA body/security/ACL preserved and checked");
const frontendChecks = checks;

const flag = process.argv.indexOf("--pglite");
if (flag === -1) {
  console.log(`PASS: ${checks} offline Staff Follow-up frontend/static checks. SQL execution NOT RUN; supply --pglite with a local PGlite module.`);
  process.exit(0);
}
const { PGlite } = await import(pathToFileURL(process.argv[flag + 1]).href);
const db = new PGlite();
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const patientId = id(1), currentId = id(999), actorId = id(101);
// Representative installed contract, not a guessed replacement for production.
// The migration must preserve ANY reviewed implementation of these surrounding checks/GA fields.
const fixtureFunction = `create or replace function public.get_staff_followup_baseline(p_appointment_id uuid)
returns table (source_record_id uuid, source_schedule_id uuid, source_visit_type text, source_visit_date text,
 gestational_age text, expected_delivery_date text, pregnancy_status text, gestational_age_anchor text, gestational_age_anchor_date text)
language plpgsql security definer set search_path to 'pg_catalog', 'public' as $fixture$
declare v_patient_id uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not exists(select 1 from public.profiles profile where profile.id=auth.uid() and lower(trim(profile.role))='staff' and lower(trim(profile.account_status))='active')
 then raise exception 'Active Staff required' using errcode='42501'; end if;
 select schedule.patient_id into v_patient_id from public.schedule schedule where schedule.id=p_appointment_id;
 if not found then raise exception 'Appointment missing' using errcode='P0002'; end if;
 if v_patient_id is null then raise exception 'Patient missing' using errcode='23502'; end if;
 return query select mr.id, mr.schedule_id, mr.type, to_char(mr.uploaded_at, 'YYYY-MM-DD'), mr.form_data ->> 'gestationalAge',
 mr.form_data ->> 'expectedDeliveryDate', mr.form_data ->> 'pregnancyStatus',
 '27'::text, '2026-10-07'::text
 from public.medical_records mr where mr.patient_id=v_patient_id and mr.schedule_id is distinct from p_appointment_id
 and lower(coalesce(mr.form_data->>'recordStatus','completed'))='completed'
 and lower(coalesce(mr.form_data->>'isDraft','false')) not in ('true','1','yes')
 and lower(coalesce(mr.form_data->>'deleted','false')) not in ('true','1','yes')
 order by mr.uploaded_at desc nulls last, mr.id desc limit 1;
end; $fixture$;`;
try {
  await db.exec(`create schema auth; create role authenticated; create role anon;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('fixture.actor',true),'')::uuid$$;
    create table public.profiles(id uuid primary key, role text, account_status text);
    create table public.schedule(id uuid primary key, patient_id uuid);
    create table public.patients(id uuid primary key, expected_delivery_date date, risk_level text);
    create table public.patient_obstetric_history(id uuid primary key, patient_id uuid, expected_delivery_date date, created_at timestamptz, updated_at timestamptz);
    create table public.medical_records(id uuid primary key, patient_id uuid, schedule_id uuid, type text, title text, form_data jsonb, uploaded_at timestamptz);
    insert into public.profiles values('${actorId}','Staff','active'); insert into public.schedule values('${currentId}','${patientId}');
    insert into public.patients values('${patientId}','2027-01-06','Low Risk');
    insert into public.patient_obstetric_history values('${id(30)}','${patientId}','2027-01-06','2026-10-07','2026-10-07');
    ${fixtureFunction}
    revoke all on function public.get_staff_followup_baseline(uuid) from public;
    grant execute on function public.get_staff_followup_baseline(uuid) to authenticated;
    select set_config('fixture.actor','${actorId}',false);`);
  const attrs = async () => (await db.query(`select oid,proowner,proacl::text,proargnames,proallargtypes,proargmodes,prorettype,proretset,prosecdef,proconfig,provolatile,proparallel,proleakproof from pg_proc where oid='public.get_staff_followup_baseline(uuid)'::regprocedure`)).rows[0];
  const read = async () => (await db.query("select * from public.get_staff_followup_baseline($1)", [currentId])).rows[0];
  const insert = async (n, data, extra = {}) => db.query("insert into public.medical_records values($1,$2,$3,$4,$4,$5,$6)",
    [id(n), extra.patientId || patientId, extra.scheduleId || id(n + 1000), extra.type || "Initial Visit", JSON.stringify({ gestationalAge: "27", visitFormType: "initial", recordStatus: "completed", ...data }), `2026-10-${String(extra.day || 7).padStart(2, "0")}T02:00:00Z`]);
  const reset = async () => {
    await db.exec("truncate public.medical_records, public.patient_obstetric_history;");
    await db.query("update public.patients set expected_delivery_date='2027-01-06',risk_level='Low Risk' where id=$1", [patientId]);
  };
  await insert(10, { expectedDeliveryDate: "", riskLevel: "Low Risk" });
  const originalAttrs = await attrs(), originalResult = await read();
  const originalDefinition = (await db.query("select pg_get_functiondef('public.get_staff_followup_baseline(uuid)'::regprocedure) as value")).rows[0].value;
  await db.exec(migration);
  equal(await attrs(), originalAttrs, "actual CREATE OR REPLACE preserves OID, owner, ACL, signature, SECURITY DEFINER/search_path and attributes");
  const patchedDefinition = (await db.query("select pg_get_functiondef('public.get_staff_followup_baseline(uuid)'::regprocedure) as value")).rows[0].value;
  check(originalDefinition.includes("if auth.uid() is null") && patchedDefinition.includes("if auth.uid() is null"), "authentication check retained");
  for (const fragment of ["lower(trim(profile.role))='staff'", "lower(trim(profile.account_status))='active'", "where schedule.id=p_appointment_id", "if not found then", "if v_patient_id is null then", "'27'::text, '2026-10-07'::text"])
    check(patchedDefinition.includes(fragment), "original authorization/GA code retained: " + fragment);
  const originalPrefix = originalDefinition.slice(0, originalDefinition.indexOf("mr.form_data ->> 'expectedDeliveryDate'"));
  const originalSuffix = originalDefinition.slice(originalDefinition.indexOf("mr.form_data ->> 'pregnancyStatus'") + "mr.form_data ->> 'pregnancyStatus'".length);
  check(patchedDefinition.startsWith(originalPrefix) && patchedDefinition.endsWith(originalSuffix), "entire installed authorization, GA projections, outer query and control flow remain verbatim");
  check(patchedDefinition.includes("patient_obstetric_history"), "actual RPC includes registration fallback");
  let result = await read();
  equal(result.expected_delivery_date, "2027-01-06", "Teresa-like blank Doctor EDD uses registration EDD");
  equal(result.pregnancy_status, "Low Risk", "actual Doctor riskLevel reaches canonical Staff risk");
  equal(Object.keys(result), ["source_record_id", "source_schedule_id", "source_visit_type", "source_visit_date", "gestational_age", "expected_delivery_date", "pregnancy_status", "gestational_age_anchor", "gestational_age_anchor_date"], "return signature exposes no extra Patient/clinical values");
  const teresaLikeForm = normalizeLoadedForm("follow_up", appointment, { intake_data: { expectedDeliveryDate: "", pregnancyStatus: "" } }, result);
  verifyUi(teresaLikeForm, "2027-01-06", "Low Risk");
  for (const key of vitals) equal(teresaLikeForm[key], "", "SQL-to-Staff current vital stays blank: " + key);
  for (const key of ["source_record_id", "source_schedule_id", "source_visit_type", "source_visit_date", "gestational_age", "gestational_age_anchor", "gestational_age_anchor_date"])
    equal(result[key], originalResult[key], "source metadata/GA result unchanged: " + key);
  await reset();
  await insert(10, { expectedDeliveryDate: "", riskLevel: "" });
  result = await read();
  equal(result.expected_delivery_date, "2027-01-06", "patient EDD used when obstetric history is unavailable");
  equal(result.pregnancy_status, "Low Risk", "patient risk used when all Doctor values are unavailable");
  await reset();
  await insert(10, { expectedDeliveryDate: "2027-01-09", riskLevel: "moderate-risk" }, { day: 6 });
  await insert(11, { expectedDeliveryDate: "", riskLevel: "Not recorded" }, { day: 7 });
  result = await read();
  equal(result.expected_delivery_date, "2027-01-09", "latest blank Doctor EDD cannot erase older meaningful Doctor EDD");
  equal(result.pregnancy_status, "Moderate Risk", "latest blank Doctor risk cannot erase older meaningful Doctor risk");
  await insert(12, { expectedDeliveryDate: "Not recorded", riskLevel: "High Risk" }, { day: 7 });
  result = await read();
  equal(result.expected_delivery_date, "2027-01-09", "EDD chosen independently from its latest meaningful record");
  equal(result.pregnancy_status, "High Risk", "risk independently uses its own latest meaningful record");
  await db.query("delete from public.medical_records where id=$1", [id(12)]);
  await db.query("insert into public.patient_obstetric_history values($1,$2,'2027-01-08','2026-10-07','2026-10-07')", [id(30), patientId]);
  equal((await read()).expected_delivery_date, "2027-01-09", "meaningful Doctor EDD precedes obstetric/patient fallback");
  for (const flags of [{ isDraft: true }, { deleted: true }, { recordStatus: "draft" }, { recordStatus: "pending" }]) {
    await insert(20, { ...flags, expectedDeliveryDate: "2099-01-01", riskLevel: "High Risk" }, { day: 8 });
    const row = await read(); equal(row.expected_delivery_date, "2027-01-09", "ineligible record EDD excluded: " + JSON.stringify(flags));
    equal(row.pregnancy_status, "Moderate Risk", "ineligible record risk excluded"); await db.query("delete from public.medical_records where id=$1", [id(20)]);
  }
  for (const extra of [{ patientId: id(2) }, { scheduleId: currentId }]) {
    await insert(20, { expectedDeliveryDate: "2099-01-01", riskLevel: "High Risk" }, { day: 8, ...extra });
    const row = await read(); equal(row.expected_delivery_date, "2027-01-09", "foreign/current-appointment EDD excluded");
    equal(row.pregnancy_status, "Moderate Risk", "foreign/current-appointment risk excluded"); await db.query("delete from public.medical_records where id=$1", [id(20)]);
  }
  for (const value of ["", null, " \t\r\n", "Not provided", "Not recorded", "-", "n/a", "none", "null", "undefined"]) {
    await reset(); await insert(10, { expectedDeliveryDate: value, riskLevel: value });
    await db.query("insert into public.patient_obstetric_history values($1,$2,'2027-01-08','2026-10-06','2026-10-06'),($3,$2,null,'2026-10-07','2026-10-07')", [id(30), patientId, id(31)]);
    result = await read(); equal(result.expected_delivery_date, "2027-01-08", "all missing Doctor EDD values fall back to meaningful obstetric EDD");
    equal(result.pregnancy_status, "Low Risk", "missing Doctor risk falls back to Patient risk");
    verifyUi(normalizeLoadedForm("follow_up", appointment, { intake_data: { expectedDeliveryDate: "", pregnancyStatus: "" } }, result), "2027-01-08", "Low Risk");
  }
  for (const [key, value, expected] of [["pregnancyStatus", "low_risk", "Low Risk"], ["pregnancy_status", "HIGH - RISK", "High Risk"], ["riskLevel", "MODERATE   RISK", "Moderate Risk"]]) {
    await reset(); await insert(10, { [key]: value }); equal((await read()).pregnancy_status, expected, "SQL risk compatibility/format normalization: " + key);
  }
  await reset(); await insert(10, { riskLevel: "High Risk" }, { day: 6 }); await insert(11, { pregnancyStatus: "Moderate Risk" }, { day: 7 });
  equal((await read()).pregnancy_status, "High Risk", "latest meaningful canonical riskLevel precedes legacy field fallback");
  await reset(); await insert(10, { expectedDeliveryDate: "", riskLevel: "" });
  await db.query("update public.patients set expected_delivery_date=null,risk_level='Not recorded' where id=$1", [patientId]);
  result = await read(); equal(result.expected_delivery_date, "", "EDD blank only when all sources missing"); equal(result.pregnancy_status, "", "risk blank only when all sources missing");
  for (const [role, status] of [["Doctor", "active"], ["Patient", "active"], ["Staff", "inactive"]]) {
    await db.query("update public.profiles set role=$1,account_status=$2 where id=$3", [role, status, actorId]);
    await assert.rejects(read(), error => error.code === "42501"); checks++;
  }
  await db.query("update public.profiles set role='Staff',account_status='active' where id=$1", [actorId]);
  await db.exec("select set_config('fixture.actor','',false)"); await assert.rejects(read(), error => error.code === "42501"); checks++;
  await db.exec(`select set_config('fixture.actor','${actorId}',false)`);
  await assert.rejects(db.query("select * from public.get_staff_followup_baseline($1)", [id(998)]), error => error.code === "P0002"); checks++;
  await db.query("insert into public.schedule values($1,null)", [id(997)]);
  await assert.rejects(db.query("select * from public.get_staff_followup_baseline($1)", [id(997)]), error => error.code === "23502"); checks++;
  await assert.rejects(db.exec(migration), /expected single EDD\/risk projections/); checks++;
  await db.exec("rollback"); equal(await attrs(), originalAttrs, "unrecognized/reapplied projection fails without changing privileges");
  await db.exec("alter function public.get_staff_followup_baseline(uuid) security invoker");
  const drifted = await attrs();
  await assert.rejects(db.exec(migration), /signature or SECURITY DEFINER\/search_path contract differs/); checks++;
  await db.exec("rollback"); equal(await attrs(), drifted, "security drift rejected without altering the installed function");
  console.log(`PASS: ${checks} checks (${frontendChecks} frontend/static, ${checks - frontendChecks} PostgreSQL/integration). Migration executed only in a disposable in-memory fixture; no network, Supabase or production writes.`);
} finally { await db.close(); }
