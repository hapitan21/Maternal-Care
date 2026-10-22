// File generation only. This module never connects to a database or starts Docker.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const packageDir = path.join(root, "docs/rehearsal/admin-audit-production");
const read = f => fs.readFileSync(path.join(root, f), "utf8").replaceAll("\r\n", "\n");
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const md5 = s => crypto.createHash("md5").update(s).digest("hex");
export const functions = [
  ["record_audit_event", "supabase/migrations/20260928030000_profiles_security_stage1.sql", "a8589348a66eaf55796e3d217d98b29a"],
  ["admin_set_patient_account_status", "supabase/migrations/20260928040000_admin_patient_status_consistency.sql", "644d99b03aeb2da0b4d4c8a7016aaf53"],
  ["admin_set_doctor_account_status", "supabase_admin_user_management.sql", "c255a40c685ac48f61ddb9f2fea666dc"],
  ["admin_set_staff_account_status", "supabase_admin_user_management.sql", "bd7fac0ad786a9d5f55c9751f27806a4"],
];
function extract(file, name) {
  const text = read(file), start = text.indexOf(`create or replace function public.${name}(`);
  assert(start >= 0, `Missing ${name}`);
  const definition = text.slice(start).match(/^[\s\S]*?\$function\$;/)?.[0];
  assert(definition, `Unexpected delimiter: ${name}`);
  return definition;
}

export function buildGeneratedFiles() {
  const definitions = functions.map(([name, file, hash]) => {
    const ddl = extract(file, name);
    assert.equal(md5(ddl.match(/as \$function\$([\s\S]*?)\$function\$;/i)[1]), hash, name);
    return ddl;
  });
  const audit = read("supabase_admin_audit_logs.sql");
  const table = audit.match(/create table if not exists public\.audit_logs \([\s\S]*?\n\);/)[0];
  const constraints = audit.match(/do \$constraints\$[\s\S]*?\$constraints\$;/)[0];
  const helper = extract("supabase_admin_user_management.sql", "admin_user_management_assert_active_admin");
  const resolve = extract("supabase/migrations/20260928040000_admin_patient_status_consistency.sql", "admin_resolve_patient_status");
  const active = extract("supabase/migrations/20260928014500_admin_schedule_broadcast.sql", "is_active_admin_realtime");
  const broadcast = extract("supabase/migrations/20260928023000_admin_audit_log_broadcast.sql", "broadcast_admin_audit_log_change");
  const identity = `do $identity$ begin
  if current_user <> 'postgres' or inet_server_addr() is not null
    or current_setting('audit_rehearsal.nonce',true) !~ '^[a-f0-9]{32}$'
    or current_database() is distinct from 'mc_audit_' || left(current_setting('audit_rehearsal.nonce',true),12)
    or current_setting('audit_rehearsal.major',true) is null
    or current_setting('server_version_num')::integer / 10000 <> current_setting('audit_rehearsal.major')::integer then
    raise exception 'STOP: not the approved isolated socket/database/version/nonce';
  end if;
end $identity$;`;
  const guard = `${identity}
do $marker$ begin
  if not exists(select 1 from rehearsal_control.identity
      where nonce=current_setting('audit_rehearsal.nonce')) then
    raise exception 'STOP: rehearsal marker mismatch';
  end if;
end $marker$;
`;
  const bootstrap = `-- SYNTHETIC ONLY. Never run on an existing Supabase project.
begin;
${identity}
do $empty$ begin
  if exists(select 1 from pg_namespace where nspname in ('auth','realtime','s4audit_private','rehearsal_control'))
    or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') then
    raise exception 'STOP: bootstrap requires a new empty database';
  end if;
end $empty$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema realtime;
create schema rehearsal_control;
revoke all on schema rehearsal_control from public,anon,authenticated,service_role;
create table rehearsal_control.identity(nonce text primary key);
insert into rehearsal_control.identity values(current_setting('audit_rehearsal.nonce'));
-- Explicit test double: no gateway signature/expiry validation is performed here.
create function auth.uid() returns uuid language sql stable as $uid$
  select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$uid$;
grant usage on schema auth to anon,authenticated,service_role;
create table public.profiles (
 id uuid primary key, full_name text not null, email text, role text not null,
 account_status text not null, created_at timestamptz default now(), updated_at timestamptz default now(),
 deactivated_at timestamptz,deactivated_by uuid,reactivated_at timestamptz,reactivated_by uuid
);
create table public.patients (
 id uuid primary key,user_id uuid references public.profiles(id),account_status text,status text,
 archived_at timestamptz,activated_at timestamptz,activated_by uuid,
 deactivated_at timestamptz,deactivated_by uuid,updated_at timestamptz default now()
);
insert into public.profiles(id,full_name,email,role,account_status) values
 ('11111111-1111-4111-8111-111111111111','Synthetic Admin','admin@audit.invalid','admin','active'),
 ('22222222-2222-4222-8222-222222222222','Synthetic Doctor','doctor@audit.invalid','doctor','active'),
 ('33333333-3333-4333-8333-333333333333','Synthetic Staff','staff@audit.invalid','staff','active'),
 ('44444444-4444-4444-8444-444444444444','Synthetic Patient','patient@audit.invalid','patient','active'),
 ('66666666-6666-4666-8666-666666666666','Synthetic Inactive','inactive@audit.invalid','admin','inactive');
insert into public.patients(id,user_id,account_status,status) values
 ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','active','active');
${table}
${constraints}
${active}
${helper}
${resolve}
${definitions.join("\n\n")}
alter table public.audit_logs enable row level security;
create policy "Active admins can read audit logs" on public.audit_logs for select to authenticated
 using ((select public.is_active_admin_realtime()));
revoke all on public.audit_logs from public,anon,authenticated;
grant select on public.audit_logs to authenticated;
alter table public.profiles enable row level security;
create policy "Own synthetic profile" on public.profiles for select to authenticated using(id=(select auth.uid()));
grant select on public.profiles to authenticated;
revoke all on public.patients from public,anon,authenticated;
revoke all on function public.admin_user_management_assert_active_admin() from public,anon,authenticated,service_role;
revoke all on function public.record_audit_event(text,text,text,text,text,jsonb,uuid) from public,anon,service_role;
grant execute on function public.record_audit_event(text,text,text,text,text,jsonb,uuid) to authenticated;
${["patient","doctor","staff"].map(r => `revoke all on function public.admin_set_${r}_account_status(uuid,text) from public,anon,service_role;
grant execute on function public.admin_set_${r}_account_status(uuid,text) to authenticated;`).join("\n")}
-- Transactional trace double; NOT a real Realtime service or external message.
create table rehearsal_control.broadcast_trace(payload jsonb,event text,topic text,is_private boolean);
create function realtime.send(payload jsonb,event text,topic text,is_private boolean) returns void
 language sql as $send$ insert into rehearsal_control.broadcast_trace values(payload,event,topic,is_private); $send$;
${broadcast}
revoke all on function public.broadcast_admin_audit_log_change() from public;
create trigger broadcast_admin_audit_log_change_trigger after insert on public.audit_logs
 for each row execute function public.broadcast_admin_audit_log_change();
insert into public.audit_logs(id,actor_user_id,actor_name,actor_role,module,action,status,description,created_at) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Synthetic Admin','admin','authentication','login','success','Synthetic historical success.','2026-10-01T00:00:00Z'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','Synthetic Admin','admin','reports','export','failure','Synthetic historical failure.','2026-10-02T00:00:00Z');
create table rehearsal_control.history as select * from public.audit_logs;
create table rehearsal_control.constraints_before as select conname,contype,convalidated,pg_get_constraintdef(oid) as definition
 from pg_constraint where conrelid='public.audit_logs'::regclass;
create table rehearsal_control.functions_before as select p.oid,p.proname,p.prosrc,p.proacl,p.proowner,
 p.prosecdef,p.proconfig,p.proargnames,p.pronargdefaults,p.proargtypes,p.prorettype,
 pg_get_expr(p.proargdefaults,0) as defaults_expression,pg_get_functiondef(p.oid) as definition
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('record_audit_event','admin_set_patient_account_status','admin_set_doctor_account_status','admin_set_staff_account_status');
-- These snapshots inspect only synthetic objects, not production data.
create function rehearsal_control.catalog_signature() returns jsonb language sql stable as $signature$
 select jsonb_build_object(
 'table',(select jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'owner',relowner,'acl',relacl) from pg_class where oid='public.audit_logs'::regclass),
 'columns',(select jsonb_agg(jsonb_build_object('name',attname,'type',atttypid,'required',attnotnull,'acl',attacl) order by attnum) from pg_attribute where attrelid='public.audit_logs'::regclass and attnum>0 and not attisdropped),
 'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public' and tablename='audit_logs'),
 'triggers',(select jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) order by tgname) from pg_trigger where tgrelid='public.audit_logs'::regclass and not tgisinternal));
$signature$;
create table rehearsal_control.catalog_before as select rehearsal_control.catalog_signature() as signature;
commit;
`;
  const proposal = read("docs/sql-drafts/20261018_admin_audit_production_only_proposal.sql");
  assert(/\ncommit;\s*$/.test(proposal), "Unexpected migration transaction ending");
  return { "guard.sql": guard, "bootstrap.sql": bootstrap, "migration.sql": proposal };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 3 && ["--write", "--seal"].includes(process.argv[2]), "Usage: --write generates SQL; --seal records package hashes. Neither executes SQL.");
  fs.mkdirSync(packageDir, { recursive: true });
  const output = process.argv[2] === "--write" ? buildGeneratedFiles() : {
    "manifest.json": JSON.stringify({ kind: "synthetic-production-audit-rehearsal", version: 1,
      productionBodyMd5: Object.fromEntries(functions.map(([name,, hash]) => [name, hash])),
      files: Object.fromEntries(fs.readdirSync(packageDir).filter(f => /\.(sql|mjs)$/.test(f)).sort()
        .map(f => [f, sha256(fs.readFileSync(path.join(packageDir, f), "utf8").replaceAll("\r\n", "\n"))]))
    }, null, 2)+"\n"
  };
  for (const [name, content] of Object.entries(output)) {
    const target = path.join(packageDir, name);
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, "utf8"), content, `Refusing to overwrite ${name}`);
    else fs.writeFileSync(target, content, { flag: "wx" });
  }
  console.log("Prepared/sealed rehearsal files only; no Docker or SQL executed.");
}
