-- UNAPPLIED PRODUCTION-ONLY REVIEW DRAFT. NOT A MIGRATION TO RUN NOW.
-- Prerequisite: separately approved 20261018 public audit-RPC restriction installed.
-- No RLS, business RPC, existing writer, Broadcast, publication, SMS or row backfill changes.
-- UNREVIEWED deliberately blocks installation. A hash match is not a security review.
-- Review the preflight inventory + installed bodies, rehearse with real JWTs and test rollback
-- BEFORE separately approving a database-specific catalog fingerprint here.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $preflight$
declare
  reviewed_catalog_md5 constant text := 'UNREVIEWED';
  observed_catalog_md5 text;
  expected_client_body_md5 constant text := 'efb73094d315918dc10777fb50dcbc23';
  f pg_catalog.pg_proc%rowtype;
begin
  if current_user <> 'postgres' then raise exception 'STOP: reviewed postgres owner required'; end if;
  if reviewed_catalog_md5 !~ '^[0-9a-f]{32}$' then
    raise exception 'STOP: installed source authorization, definitions and duplicate producers have not been approved';
  end if;
  with source_relations as (
  select c.oid, n.nspname, c.relname, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in (
    'audit_logs','profiles','patients','schedule','appointment_events','staff_visit_intake',
    'medical_records','reminders','medication_reminders','create_patient_appointment_request',
    'medication_reminder_occurrences')
), catalog_entries as (
  select 'relation:'||r.relname as key, pg_catalog.to_jsonb(r)::text as value from source_relations r
  union all
  select 'column:'||r.relname||':'||a.attname,
    pg_catalog.jsonb_build_array(a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid))::text
  from source_relations r join pg_catalog.pg_attribute a on a.attrelid=r.oid
  left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attnum>0 and not a.attisdropped
  union all
  select 'constraint:'||r.relname||':'||c.conname,
    pg_catalog.jsonb_build_array(c.convalidated,pg_catalog.pg_get_constraintdef(c.oid))::text
  from source_relations r join pg_catalog.pg_constraint c on c.conrelid=r.oid
  union all
  select 'policy:'||r.relname||':'||p.polname,
    pg_catalog.jsonb_build_array(p.polcmd,p.polpermissive,p.polroles,
      pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))::text
  from source_relations r join pg_catalog.pg_policy p on p.polrelid=r.oid
  union all
  select 'trigger:'||r.relname||':'||t.tgname,
    pg_catalog.jsonb_build_array(t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid))::text
  from source_relations r join pg_catalog.pg_trigger t on t.tgrelid=r.oid where not t.tgisinternal
  union all
  select 'function:'||p.oid::pg_catalog.regprocedure::text,
    pg_catalog.jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.proconfig,
      pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid),E'\r\n',E'\n'))::text
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f'
  union all
  select 'schema:'||n.nspname, pg_catalog.jsonb_build_array(n.nspowner,n.nspacl)::text
  from pg_catalog.pg_namespace n where n.nspname in ('public','auth')
  union all
  select 'role:'||r.rolname, pg_catalog.to_jsonb(r)::text from pg_catalog.pg_roles r
  where r.rolname in ('postgres','anon','authenticated','service_role','authenticator')
  union all
  select 'membership:'||m.roleid::text||':'||m.member::text, pg_catalog.to_jsonb(m)::text
  from pg_catalog.pg_auth_members m
)
select pg_catalog.md5(pg_catalog.string_agg(key||'='||value,E'\n' order by key)) into observed_catalog_md5
from catalog_entries;
  if observed_catalog_md5 is distinct from reviewed_catalog_md5 then
    raise exception 'STOP: installed catalog drift; re-review, never bypass the guard';
  end if;
  if pg_catalog.to_regnamespace('mc_audit_producers') is not null
     or pg_catalog.to_regnamespace('s4audit_private') is not null
     or (select count(*) from pg_catalog.pg_attribute
       where attrelid='public.audit_logs'::pg_catalog.regclass and attnum>0 and not attisdropped) <> 15 then
    raise exception 'STOP: not an untouched producer namespace and original production schema';
  end if;
  select * into f from pg_catalog.pg_proc
  where oid=pg_catalog.to_regprocedure('public.record_audit_event(text,text,text,text,text,jsonb,uuid)');
  if not found or not f.prosecdef or pg_catalog.pg_get_userbyid(f.proowner)<>'postgres'
     or not coalesce(f.proconfig @> array['search_path=""'],false)
     or pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\r\n',E'\n'))<>expected_client_body_md5 then
    raise exception 'STOP: reviewed restricted public audit RPC is a prerequisite';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='record_audit_event') <> 1 then
    raise exception 'STOP: unexpected public audit overloads';
  end if;
  if pg_catalog.has_table_privilege('authenticated','public.audit_logs','INSERT,UPDATE,DELETE,TRUNCATE')
     or pg_catalog.has_any_column_privilege('authenticated','public.audit_logs','INSERT,UPDATE')
     or pg_catalog.has_table_privilege('anon','public.audit_logs','INSERT,UPDATE,DELETE,TRUNCATE')
     or pg_catalog.has_any_column_privilege('anon','public.audit_logs','INSERT,UPDATE')
     or not (select relrowsecurity from pg_catalog.pg_class where oid='public.audit_logs'::regclass) then
    raise exception 'STOP: audit direct-write protection differs';
  end if;
  if pg_catalog.to_regprocedure('public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)') is null then
    raise exception 'STOP: reviewed audit security prerequisite missing';
  end if;
  if pg_catalog.has_function_privilege('authenticated',
       'public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE')
     or pg_catalog.has_function_privilege('anon',
       'public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE')
     or pg_catalog.has_function_privilege('service_role',
       'public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE') then
    raise exception 'STOP: existing internal writer is publicly callable';
  end if;
  if not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.audit_logs'::regclass
    and tgname='broadcast_admin_audit_log_change_trigger' and tgenabled in ('O','A') and not tgisinternal) then
    raise exception 'STOP: preserve the installed private Broadcast trigger';
  end if;
  if pg_catalog.has_table_privilege('authenticated','public.appointment_events','INSERT,UPDATE,DELETE')
     or pg_catalog.has_any_column_privilege('authenticated','public.appointment_events','INSERT,UPDATE')
     or pg_catalog.has_table_privilege('authenticated','public.medication_reminder_occurrences','INSERT,UPDATE,DELETE')
     or pg_catalog.has_any_column_privilege('authenticated','public.medication_reminder_occurrences','INSERT,UPDATE') then
    raise exception 'STOP: canonical ledger and adherence writes must remain RPC-controlled';
  end if;
end;
$preflight$;

create schema mc_audit_producers authorization postgres;
revoke all on schema mc_audit_producers from public,anon,authenticated,service_role;

-- Transactional receipt, no clinical values/digests. A failed business transaction also rolls
-- back its receipt and audit insert. Not an exactly-once guarantee for duplicate business rows.
create table mc_audit_producers.receipts (
  event_key text primary key,
  audit_id uuid not null unique,
  created_at timestamptz not null default pg_catalog.now()
);
revoke all on table mc_audit_producers.receipts from public,anon,authenticated,service_role;

create function mc_audit_producers.capture_business_mutation()
returns trigger language plpgsql security definer set search_path=''
as $producer$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  actor_name text;
  n jsonb;
  o jsonb := '{}'::jsonb;
  s public.schedule%rowtype;
  module_name text;
  action_name text;
  entity_type_name text;
  description_text text;
  source_id text;
  event_key_text text;
  receipt_id uuid;
  old_status text;
  new_status text;
  form_type text;
  saved_payload jsonb;
  previous_payload jsonb;
begin
  if TG_TABLE_SCHEMA <> 'public' or TG_WHEN <> 'AFTER' or TG_LEVEL <> 'ROW'
     or TG_NARGS <> 0 or TG_OP not in ('INSERT','UPDATE','DELETE') then
    raise exception 'Unexpected producer attachment';
  end if;
  -- Authenticated human mutations only. Cron, SQL Editor, service and null-auth work
  -- must never be attributed to a guessed human actor. No JWT role/name/actor from row JSON.
  if actor_id is null or auth.role() is distinct from 'authenticated' then return null; end if;
  select pg_catalog.lower(pg_catalog.btrim(p.role)),
    pg_catalog.left(coalesce(nullif(pg_catalog.btrim(p.full_name),''),'Unknown user'),160)
  into actor_role,actor_name from public.profiles p
  where p.id=actor_id and pg_catalog.lower(pg_catalog.btrim(p.account_status))='active';
  if not found or actor_role is null or actor_role not in ('admin','staff','doctor','patient') then return null; end if;
  if actor_role='patient' then actor_name := 'Patient'; end if;
  if TG_OP <> 'INSERT' then o := pg_catalog.to_jsonb(OLD); end if;
  if TG_OP = 'DELETE' then n := o; else n := pg_catalog.to_jsonb(NEW); end if;
  source_id := n->>'id';
  old_status := pg_catalog.lower(pg_catalog.btrim(coalesce(o->>'status','')));
  new_status := pg_catalog.lower(pg_catalog.btrim(coalesce(n->>'status','')));

  -- PHASE A PRIORITY: actual clinic schedule writes, canonical reschedule events, clinical saves.
  if TG_TABLE_NAME='schedule' and actor_role in ('staff','doctor','admin') then
    if n->>'patient_id' is null then return null; end if;
    module_name := 'appointment_management'; entity_type_name := 'appointment';
    -- No free-text metadata is trusted to assert or suppress an event. Current create RPCs
    -- persist 'scheduled'; pending request rows are not confirmed clinic appointments.
    -- Modern approval's INSERT and request acceptance share the same receipt below.
    if new_status in ('scheduled','upcoming') and (TG_OP='INSERT'
        or (TG_OP='UPDATE' and old_status='pending')) then
      action_name := 'create'; description_text := 'An appointment was created.';
    elsif TG_OP='UPDATE' and new_status in ('cancel','canceled','cancelled')
        and old_status not in ('cancel','canceled','cancelled') then
      action_name := 'cancel'; description_text := 'An appointment was cancelled.';
    elsif TG_OP='UPDATE' and new_status in ('checked_in','checked-in','checked in')
        and old_status not in ('checked_in','checked-in','checked in') then
      action_name := 'check_in'; description_text := 'An appointment was checked in.';
    end if;
  elsif TG_TABLE_NAME='appointment_events' and TG_OP='INSERT'
      and actor_role in ('staff','doctor','admin') and n->>'event_type'='appointment_rescheduled' then
    select * into s from public.schedule where id=(n->>'schedule_id')::uuid;
    if not found or s.patient_id::text is distinct from n->>'patient_id' then return null; end if;
    module_name := 'appointment_management'; action_name := 'reschedule';
    entity_type_name := 'appointment_reschedule_event'; description_text := 'An appointment was rescheduled.';
    -- No schedule time-update trigger: exactly one producer for the canonical event.
  elsif TG_TABLE_NAME='staff_visit_intake' and TG_OP in ('INSERT','UPDATE')
      and actor_role in ('staff','admin') and new_status='staff_completed' then
    select * into s from public.schedule where id=(n->>'appointment_id')::uuid;
    if not found or s.patient_id::text is distinct from n->>'patient_id'
        or s.doctor_id::text is distinct from n->>'doctor_id'
        or n->>'visit_type' is null or n->>'visit_type' not in ('initial','follow_up') then return null; end if;
    -- staff_id on an UPSERT remains the original creator, not necessarily the current editor.
    -- Actor is always auth.uid(); do not overwrite the business row or guess from staff_id.
    saved_payload := coalesce(n->'intake_data','{}'::jsonb)-array['staffSavedAt','updatedAt'];
    previous_payload := coalesce(o->'intake_data','{}'::jsonb)-array['staffSavedAt','updatedAt'];
    if TG_OP='UPDATE' and old_status='staff_completed'
       and saved_payload=previous_payload and n->>'visit_type' is not distinct from o->>'visit_type' then return null; end if;
    module_name := 'visit_records';
    action_name := case when TG_OP='INSERT' or old_status<>'staff_completed' then 'create' else 'update' end;
    if n->>'visit_type'='initial' then
      entity_type_name := 'staff_initial_assessment'; description_text := 'Staff Initial Assessment ';
    else
      entity_type_name := 'staff_follow_up_assessment'; description_text := 'Staff Follow-Up Assessment ';
    end if;
    description_text := description_text || case when action_name='create' then 'saved.' else 'updated.' end;
  elsif TG_TABLE_NAME='medical_records' and TG_OP in ('INSERT','UPDATE')
      and actor_role in ('doctor','staff','admin') and n->>'schedule_id' is not null then
    select * into s from public.schedule where id=(n->>'schedule_id')::uuid;
    if not found or s.patient_id::text is distinct from n->>'patient_id'
        or s.doctor_id::text is distinct from n->>'doctor_id' then return null; end if;
    saved_payload := coalesce(n->'form_data','{}'::jsonb);
    previous_payload := coalesce(o->'form_data','{}'::jsonb);
    if coalesce(saved_payload->>'recordStatus','')<>'completed'
       or coalesce(saved_payload->>'isDraft','false') in ('true','1','yes')
       or coalesce(saved_payload->>'deleted','false') in ('true','1','yes') then return null; end if;
    form_type := saved_payload->>'visitFormType';
    if form_type not in ('initial','follow_up') or form_type is null then return null; end if;
    if TG_OP='UPDATE' and (n-array['updated_at','uploaded_at','form_data'])=(o-array['updated_at','uploaded_at','form_data'])
      and (saved_payload-array['completedAt','updatedAt'])=(previous_payload-array['completedAt','updatedAt']) then return null; end if;
    module_name := 'visit_records'; action_name := case when TG_OP='INSERT' then 'create' else 'update' end;
    if form_type='initial' then
      entity_type_name := 'initial_visit_record'; description_text := 'Initial Visit record ';
    else
      entity_type_name := 'follow_up_visit_record'; description_text := 'Follow-Up Visit record ';
    end if;
    description_text := description_text || case when action_name='create' then 'saved.' else 'updated.' end;
    -- A persisted visit record, NOT a separate pregnancy-state sync or clinical completion claim.

  -- Remaining requested coverage. All source write permissions require installed review.
  elsif TG_TABLE_NAME='patients' and TG_OP='UPDATE' and actor_role in ('staff','admin')
      and o->>'registration_status'='awaiting_patient_access_confirmation'
      and n->>'registration_status'='completed' and n->>'access_handoff_confirmed_by'=actor_id::text
      and n->>'access_handoff_confirmed_at' is not null then
    module_name := 'patient_management'; action_name := 'register'; entity_type_name := 'patient_registration';
    description_text := 'Patient registration finished.';
  elsif TG_TABLE_NAME='medication_reminders' and actor_role in ('doctor','admin') then
    if TG_OP='UPDATE' and (n-'updated_at')=(o-'updated_at') then return null; end if;
    module_name := 'reminder_management'; entity_type_name := 'medication_reminder';
    action_name := case TG_OP when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'update' end;
    description_text := 'A medication reminder was ' || case TG_OP when 'INSERT' then 'created.' when 'DELETE' then 'deleted.' else 'updated.' end;
  elsif TG_TABLE_NAME='reminders' and actor_role in ('doctor','staff','admin')
      and n->>'reminder_type'='appointment' then
    -- Scheduler counters/status updates do not imply a Doctor edit or a successful send.
    if TG_OP='UPDATE' and
      (n-array['updated_at','status','sent_at','next_trigger_at','last_triggered_at','trigger_count','error_code'])=
      (o-array['updated_at','status','sent_at','next_trigger_at','last_triggered_at','trigger_count','error_code']) then return null; end if;
    module_name := 'reminder_management'; entity_type_name := 'appointment_reminder';
    action_name := case TG_OP when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'update' end;
    description_text := 'An appointment reminder was ' || case TG_OP when 'INSERT' then 'created.' when 'DELETE' then 'deleted.' else 'updated.' end;
  elsif TG_TABLE_NAME='create_patient_appointment_request' then
    if TG_OP='INSERT' and actor_role='patient' and new_status='pending' and exists(
      select 1 from public.patients p where p.id::text=n->>'patient_id' and p.user_id=actor_id
        and pg_catalog.lower(pg_catalog.btrim(p.account_status))='active' and p.archived_at is null
        and pg_catalog.lower(pg_catalog.btrim(coalesce(p.status,''))) not in ('inactive','archived','deleted')) then
      module_name := 'appointment_management'; action_name := 'create';
      entity_type_name := 'appointment_booking_request'; description_text := 'A Patient booking request was submitted.';
    elsif TG_OP='UPDATE' and actor_role in ('staff','admin') and old_status='pending' and new_status='accepted'
        and n->>'reviewed_by'=actor_id::text and n->>'reviewed_at' is not null then
      select * into s from public.schedule where id=(n->>'schedule_id')::uuid;
      if not found or s.patient_id::text is distinct from n->>'patient_id'
          or s.doctor_id::text is distinct from n->>'doctor_id'
          or s.status is null or s.status not in ('scheduled','upcoming') then return null; end if;
      module_name := 'appointment_management'; action_name := 'create'; entity_type_name := 'appointment';
      description_text := 'An appointment was created.';
      -- Same create receipt as the schedule INSERT; legacy schedule acceptance also covered.
      source_id := s.id::text;
    end if;
  elsif TG_TABLE_NAME='medication_reminder_occurrences' and TG_OP='UPDATE' and actor_role='patient'
      and old_status='notified' and new_status in ('taken','skipped') and exists(
        select 1 from public.patients p where p.id::text=n->>'patient_id' and p.user_id=actor_id
          and pg_catalog.lower(pg_catalog.btrim(p.account_status))='active' and p.archived_at is null
          and pg_catalog.lower(pg_catalog.btrim(coalesce(p.status,''))) not in ('inactive','archived','deleted')) then
    module_name := 'reminder_management'; action_name := 'acknowledge'; entity_type_name := 'medication_adherence';
    description_text := 'A Patient medication adherence response was recorded.';
    -- No drug, dosage, timing, response value, patient identifier or clinical content is copied.
  end if;

  if action_name is null then return null; end if;
  if source_id is null then raise exception 'Source identity missing'; end if;
  -- Creates, registration, canonical reschedules, adherence: once per source identity.
  -- Updates/cancel/check-in: once per transaction, entity and action; distinct later edits remain visible.
  event_key_text := entity_type_name||':'||source_id||':'||action_name;
  if action_name in ('update','cancel','check_in') then
    event_key_text := event_key_text||':'||pg_catalog.pg_current_xact_id()::text;
  end if;
  receipt_id := pg_catalog.gen_random_uuid();
  insert into mc_audit_producers.receipts(event_key,audit_id) values(event_key_text,receipt_id)
  on conflict(event_key) do nothing returning audit_id into receipt_id;
  if not found then return null; end if;
  insert into public.audit_logs(id,actor_user_id,actor_name,actor_role,module,action,status,
    entity_type,entity_id,description,metadata,request_id)
  values(receipt_id,actor_id,actor_name,actor_role,module_name,action_name,'success',entity_type_name,
    case when entity_type_name='patient_registration' then null else source_id end,description_text,
    pg_catalog.jsonb_build_object('event_source','server_transaction','producer','mc_audit_producers_v1'),
    pg_catalog.gen_random_uuid());
  -- No catch-and-continue: receipt + audit + business mutation commit or roll back together.
  return null;
end;
$producer$;
alter function mc_audit_producers.capture_business_mutation() owner to postgres;
revoke all on function mc_audit_producers.capture_business_mutation() from public,anon,authenticated,service_role;

-- No replace/drop: existing producers must be reviewed first to prevent overlapping audit writes.
create trigger mc_audit_schedule after insert or update on public.schedule
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_reschedule after insert on public.appointment_events
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_staff_assessment after insert or update on public.staff_visit_intake
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_visit_record after insert or update on public.medical_records
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_registration after update on public.patients
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_medication_reminder after insert or update or delete on public.medication_reminders
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_appointment_reminder after insert or update or delete on public.reminders
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_booking_request after insert or update on public.create_patient_appointment_request
  for each row execute function mc_audit_producers.capture_business_mutation();
create trigger mc_audit_adherence after update on public.medication_reminder_occurrences
  for each row execute function mc_audit_producers.capture_business_mutation();

do $private_access$
declare checked_role text;
begin
  foreach checked_role in array array['anon','authenticated','service_role'] loop
    if pg_catalog.has_schema_privilege(checked_role,'mc_audit_producers','USAGE')
       or pg_catalog.has_function_privilege(checked_role,
         'mc_audit_producers.capture_business_mutation()','EXECUTE')
       or pg_catalog.has_table_privilege(checked_role,'mc_audit_producers.receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception 'STOP: inherited private producer access for %',checked_role;
    end if;
  end loop;
end;
$private_access$;
commit;
