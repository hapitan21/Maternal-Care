// Offline only. Real presentation functions + SQL structural contracts, NOT PostgreSQL execution.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mapAdminAuditActivity } from "../src/lib/adminDashboard.js";
import { getAuditEventDetails } from "../src/lib/adminAuditPresentation.js";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sql = read("docs/sql-drafts/20261019_admin_audit_business_producers.sql");
const preflight = read("docs/sql-drafts/20261019_admin_audit_business_preflight.sql");
const prerequisite = read("docs/sql-drafts/20261018_admin_audit_production_only_proposal.sql");
let assertions = 0, scenarios = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const scenario = (name, run) => { run(); scenarios++; console.log(`PASS ${name}`); };
scenario("Production and hardened hashes identify ordered prerequisites, not interchangeable baselines", () => {
  const hash = body => crypto.createHash("md5").update(body).digest("hex");
  const original = read("supabase/migrations/20260928030000_profiles_security_stage1.sql")
    .split("function public.record_audit_event(")[1].match(/as \$function\$([\s\S]*?)\$function\$;/)[1];
  const hardened = prerequisite.match(/as \$client\$([\s\S]*?)\$client\$;/)[1];
  check(hash(original), "a8589348a66eaf55796e3d217d98b29a");
  check(hash(hardened), "efb73094d315918dc10777fb50dcbc23");
  check(hash(original) === hash(hardened), false);
  check(prerequisite.includes(`'public.record_audit_event(text,text,text,text,text,jsonb,uuid)', '${hash(original)}'`), true);
  check(sql.includes(`expected_client_body_md5 constant text := '${hash(hardened)}'`), true);
  check(read("docs/rehearsal/admin-audit-production/migration.sql"), prerequisite);
  check(sql.includes("reviewed_catalog_md5 constant text := 'UNREVIEWED'"), true);
});
scenario("Read-only inventory includes guarded clinical facades and their unchecked helpers", () => {
  for (const name of ["save_appointment_visit_record", "save_staff_visit_intake", "get_appointment_visit_form_type", "get_staff_visit_intake"]) {
    check(preflight.includes(`'${name}'`), true);
    check(preflight.includes(`'${name}_unchecked_v1'`), true);
  }
  check(preflight.includes("has_function_privilege('authenticated',p.oid,'EXECUTE')"), true);
  const assigned = read("supabase/migrations/20260925214000_fix_assigned_doctor_visit_authorization.sql");
  check(assigned.includes("v_assigned_doctor_id is distinct from auth.uid()"), true);
  check(assigned.includes("return public.save_appointment_visit_record_unchecked_v1("), true);
  const original = read("supabase_patient_visit_form_routing.sql");
  check(original.includes("case when v_actor_role = 'doctor' then auth.uid() else null end"), true);
});
const types = {
  appointment: ["appointment_management", ["create", "cancel", "check_in"]],
  appointment_reschedule_event: ["appointment_management", ["reschedule"]],
  staff_initial_assessment: ["visit_records", ["create", "update"]],
  staff_follow_up_assessment: ["visit_records", ["create", "update"]],
  initial_visit_record: ["visit_records", ["create", "update"]],
  follow_up_visit_record: ["visit_records", ["create", "update"]],
  patient_registration: ["patient_management", ["register"]],
  medication_reminder: ["reminder_management", ["create", "update", "delete"]],
  appointment_reminder: ["reminder_management", ["create", "update", "delete"]],
  appointment_booking_request: ["appointment_management", ["create"]],
  medication_adherence: ["reminder_management", ["acknowledge"]],
};
const row = (entity_type, module, action) => ({ id: "synthetic-event", entity_type, module, action,
  actor_name: "Synthetic Actor", actor_role: "doctor", status: "success", audit_source: "server_transaction",
  description: "SENSITIVE synthetic clinical content", created_at: "2026-10-19T00:00:00Z" });
scenario("All proposed business types/actions render safe fixed labels and retain destinations", () => {
  const page = read("src/pages/admin/AdminAuditLogs.jsx");
  const canonicalModules = page.match(/const canonicalModules = \[([\s\S]*?)\];/)[1];
  const canonicalActions = page.match(/const canonicalActions = \[([\s\S]*?)\];/)[1];
  for (const [type, [module, actions]] of Object.entries(types)) for (const action of actions) {
    const event = row(type, module, action);
    const mapped = mapAdminAuditActivity(event, () => "synthetic time");
    check(mapped.description.includes("SENSITIVE"), false);
    check(mapped.id, event.id); check(mapped.actorRole, "Doctor");
    check(canonicalModules.includes(`"${module}"`), true);
    check(canonicalActions.includes(`"${action}"`), true);
    check(mapped.target, module === "appointment_management" ? "appointments" : module === "patient_management" ? "users" : "logs");
  }
});
scenario("Module/type mismatches and prototype keys never select a business label", () => {
  for (const type of ["initial_visit_record", "constructor", "__proto__", "toString"]) {
    const mapped = mapAdminAuditActivity(row(type, "visit_records", "constructor"), () => "now");
    check(mapped.description, "A visit-record activity was recorded.");
  }
  check(mapAdminAuditActivity(row("appointment", "visit_records", "create"), () => "now").description,
    "A visit-record activity was recorded.");
});
scenario("Legacy rows and origin trust classification remain unchanged", () => {
  const legacy = row(undefined, "authentication", "login"); legacy.description = "Signed in.";
  check(mapAdminAuditActivity(legacy, () => "now").description, "Signed in.");
  check(getAuditEventDetails(row("appointment", "appointment_management", "create"))[0][1], "Server transaction (metadata marker)");
  check(getAuditEventDetails({ event_origin: "client_reported", status: "success", audit_source: "server_transaction" })[0][1],
    "Client reported (unverified)");
});
scenario("Draft is blocked pending installed review and pins the existing restricted client wrapper", () => {
  check(sql.includes("reviewed_catalog_md5 constant text := 'UNREVIEWED'"), true);
  const body = prerequisite.match(/as \$client\$([\s\S]*?)\$client\$;/)[1];
  check(sql.includes(crypto.createHash("md5").update(body).digest("hex")), true);
  for (const guard of ["catalog drift", "s4audit_private", "<> 15", "record_internal_audit_event", "has_any_column_privilege",
    "broadcast_admin_audit_log_change_trigger", "canonical ledger and adherence writes must remain RPC-controlled"]) {
    check(sql.includes(guard), true);
  }
  const query = preflight.split("-- BEGIN CATALOG FINGERPRINT\n")[1].split("\n-- END CATALOG FINGERPRINT")[0];
  check(sql.includes(query.replace("as catalog_md5\nfrom catalog_entries;", "into observed_catalog_md5\nfrom catalog_entries;")), true);
});
scenario("Producer is private, transaction-bound, derives actor and fixed actions rather than accepting claims", () => {
  check(sql.includes("create function mc_audit_producers.capture_business_mutation()"), true);
  check(sql.includes("actor_id uuid := auth.uid()"), true);
  check(sql.includes("auth.role() is distinct from 'authenticated'"), true);
  check(sql.includes("where p.id=actor_id"), true);
  check(sql.includes("if actor_role='patient' then actor_name := 'Patient'"), true);
  for (const object of ["schema mc_audit_producers", "table mc_audit_producers.receipts", "function mc_audit_producers.capture_business_mutation()"]) {
    check(sql.includes(`revoke all on ${object} from public,anon,authenticated,service_role`), true);
  }
  check(/grant\s+/i.test(sql.replace(/--[^\n]*/g, "")), false);
  check(/exception\s+when\s+others/i.test(sql), false);
  check(sql.includes("on conflict(event_key) do nothing returning audit_id into receipt_id"), true);
  check(sql.includes("if not found then return null; end if;\n  insert into public.audit_logs"), true);
  check(sql.includes("pg_catalog.pg_current_xact_id()"), true);
});
scenario("Canonical reschedule and accepted-request creation have one source identity; clinical retries ignore timestamps", () => {
  for (const fragment of ["TG_TABLE_NAME='appointment_events' and TG_OP='INSERT'", "old_status='pending' and new_status='accepted'",
    "new_status in ('scheduled','upcoming')", "source_id := s.id::text",
    "s.patient_id::text is distinct from n->>'patient_id'", "saved_payload=previous_payload",
    "saved_payload-array['completedAt','updatedAt']", "n->>'visit_type' is null", "n->>'schedule_id' is not null"]) check(sql.includes(fragment), true);
  check(/new_status='approved'/.test(sql), false);
  check(sql.includes("schedule_metadata"), false);
  check(/action_name\s*:=\s*'complete'/.test(sql), false);
  check(/insert into public\.(schedule|medical_records|staff_visit_intake)/i.test(sql), false);
});
scenario("Patient ownership and actual notified response transitions are required", () => {
  check(sql.includes("old_status='notified' and new_status in ('taken','skipped')"), true);
  check((sql.match(/p\.user_id=actor_id/g) || []).length, 2);
  check((sql.match(/p\.archived_at is null/g) || []).length, 2);
  check(sql.includes("n->>'access_handoff_confirmed_by'=actor_id::text"), true);
  check(/TG_OP\s*=\s*'DELETE' then n := o/.test(sql), true);
});
scenario("Only minimal audit metadata is emitted; existing business/RLS/Realtime/SMS definitions are untouched", () => {
  const insertion = sql.slice(sql.indexOf("insert into public.audit_logs"), sql.indexOf("-- No catch-and-continue"));
  check(insertion.includes("'event_source','server_transaction','producer','mc_audit_producers_v1'"), true);
  check(/form_data|intake_data|patient_id|medication_name|dosage|description'|phone|email/i.test(insertion), false);
  check(insertion.includes("entity_type_name='patient_registration' then null"), true);
  const ddl = sql.replace(/--[^\n]*/g, "");
  check(/(?:alter|drop)\s+(?:policy|publication|table)|create\s+(?:or replace\s+)?function\s+public\./i.test(ddl), false);
  const tables = [...sql.matchAll(/create trigger \w+ after [^;]+? on public\.(\w+)\s/g)].map(m => m[1]);
  check(tables.sort(), ["schedule", "appointment_events", "staff_visit_intake", "medical_records", "patients", "medication_reminders",
    "reminders", "create_patient_appointment_request", "medication_reminder_occurrences"].sort());
  check(/net\.http|iprog|send_notification|send-notification/i.test(ddl), false);
});
scenario("Read-only preflight has six SELECTs and balanced SQL dollar quoting", () => {
  const text = preflight.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
  check(text.split(";").map(x => x.trim()).filter(Boolean).length, 6);
  check(/\b(insert|update|delete|alter|drop|create|grant|revoke|call|do|execute)\b/i.test(text), false);
  const tags = sql.match(/\$[a-z_]+\$/g);
  check(tags, ["$preflight$", "$preflight$", "$producer$", "$producer$", "$private_access$", "$private_access$"]);
  check(sql.trim().endsWith("commit;"), true);
});
console.log(`${scenarios} scenarios / ${assertions} assertions PASS; no SQL executed. Database authorization, trigger syntax, concurrency and rollback remain isolated rehearsal gates.`);
