-- Phase 8C: resolve stale processing ambiguity; never replay a provider request.
-- Capability only. No recovery execution; recovery cron is inactive at commit.
begin;

do $preflight$
declare
  v_column record;
  v_contract record;
  v_expression text;
  v_states text[];
  v_function oid;
  v_piece text;
  v_normalized text;
begin
  if pg_catalog.to_regclass('public.patient_notification_native_push_deliveries') is null then
    raise exception 'Native stale recovery preflight: delivery ledger is missing.';
  end if;
  for v_column in select * from (values
    ('id','uuid',true),('notification_id','uuid',true),('device_id','uuid',true),
    ('status','text',true),('attempt_count','integer',true),('claim_token','uuid',false),
    ('attempted_at','timestamp with time zone',true),('created_at','timestamp with time zone',true),
    ('updated_at','timestamp with time zone',true),('sent_at','timestamp with time zone',false),
    ('next_attempt_at','timestamp with time zone',false),('last_failure_class','text',false),
    ('fcm_http_status','integer',false),('error_code','text',false),('error_message','text',false),
    ('provider_message_id','text',false)
  ) as expected(name,type_name,required)
  loop
    if not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid='public.patient_notification_native_push_deliveries'::regclass
        and a.attname=v_column.name and not a.attisdropped
        and pg_catalog.format_type(a.atttypid,a.atttypmod)=v_column.type_name
        and a.attnotnull=v_column.required) then
      raise exception 'Native stale recovery preflight: ledger column % differs from the reviewed contract.',v_column.name;
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_attribute where
    attrelid='public.patient_notification_native_push_deliveries'::regclass
    and attname in ('recovery_at','recovery_reason') and not attisdropped) then
    raise exception 'Native stale recovery preflight: recovery metadata already exists.';
  end if;
  select pg_catalog.pg_get_expr(c.conbin,c.conrelid) into v_expression
  from pg_catalog.pg_constraint c where c.conrelid='public.patient_notification_native_push_deliveries'::regclass
    and c.conname='patient_native_push_deliveries_status_check' and c.contype='c' and c.convalidated;
  if not found then raise exception 'Native stale recovery preflight: reviewed status constraint is missing.'; end if;
  select pg_catalog.array_agg(parts[1] order by parts[1]) into v_states
    from pg_catalog.regexp_matches(v_expression,'''([^'']*)''','g') as parts;
  v_expression:=pg_catalog.regexp_replace(v_expression,'''[^'']*''','?','g');
  v_expression:=pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.replace(v_expression,'::text',''),'[[:space:]()]','','g'));
  if v_expression <> 'status=anyarray[?,?,?,?]'
     or v_states is distinct from array['disabled_token','failed','processing','sent']::text[] then
    raise exception 'Native stale recovery preflight: status constraint differs from the reviewed contract.';
  end if;
  -- Catalog expression hashes retain parentheses/operator grouping. Normalize only
  -- whitespace, text casts and case; a changed boolean tree must fail closed.
  for v_contract in select * from (values
    ('patient_native_push_deliveries_attempt_count_check','077f5497ee0c8ec4945e41b14d96cfe9'),
    ('patient_native_push_deliveries_sent_state_check','059808cf1e3b9e67b15ee7dc905d7864'),
    ('patient_native_push_failure_class_check','aecf7009d5d0a1802516e560cae245ce'),
    ('patient_native_push_retry_deadline_check','f24f0d45dc6777d0f976d6ff6f733fe4'),
    ('patient_native_push_active_result_check','1ee5e563699897d0f49821b7cbbd64b6')
  ) as expected(name,expression_hash)
  loop
    select pg_catalog.pg_get_expr(c.conbin,c.conrelid) into v_expression from pg_catalog.pg_constraint c
    where c.conrelid='public.patient_notification_native_push_deliveries'::regclass
      and c.conname=v_contract.name and c.contype='c' and c.convalidated;
    if not found then
      raise exception 'Native stale recovery preflight: constraint % is missing.',v_contract.name;
    end if;
    v_normalized:='';
    for v_piece in select parts[1] from pg_catalog.regexp_matches(v_expression,'''(?:''''|[^''])*''|[^'']+','g') as parts
    loop
      if pg_catalog.left(v_piece,1)='''' then
        v_normalized:=v_normalized||v_piece;
      else
        v_normalized:=v_normalized||pg_catalog.lower(pg_catalog.regexp_replace(
          pg_catalog.replace(v_piece,'::text',''),'[[:space:]]','','g'));
      end if;
    end loop;
    if pg_catalog.md5(v_normalized) is distinct from v_contract.expression_hash then
      raise exception 'Native stale recovery preflight: constraint % differs from the reviewed contract.',v_contract.name;
    end if;
  end loop;
  if not exists(select 1 from pg_catalog.pg_constraint c
    where c.conrelid='public.patient_notification_native_push_deliveries'::regclass
      and c.conname='patient_native_push_deliveries_notification_device_key' and c.contype='u'
      and not c.condeferrable and c.convalidated
      and c.conkey=array[
        (select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='notification_id'),
        (select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='device_id')]) then
    raise exception 'Native stale recovery preflight: notification/device uniqueness differs from the reviewed contract.';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid='public.patient_notification_native_push_deliveries'::regclass)
     or pg_catalog.has_table_privilege('service_role','public.patient_notification_native_push_deliveries','INSERT,UPDATE')
     or not pg_catalog.has_table_privilege('service_role','public.patient_notification_native_push_deliveries','SELECT')
     or pg_catalog.has_table_privilege('anon','public.patient_notification_native_push_deliveries','SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('authenticated','public.patient_notification_native_push_deliveries','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Native stale recovery preflight: ledger privilege boundary differs from the reviewed contract.';
  end if;
  -- Exact reviewed Phase 8B bodies (only CRLF normalized). Do not replace drifted RPCs.
  for v_contract in select * from (values
    ('public.claim_patient_native_push_delivery(uuid,uuid,text)','6e6ce88cf49f121bab768b931d39f069','v',
      'TABLE(delivery_id uuid, claim_token uuid, attempt_count integer, attempted_at timestamp with time zone)'),
    ('public.finalize_patient_native_push_delivery(uuid,uuid,integer,text,integer,text,text,timestamp with time zone,bigint)',
      '04614f8130f3aa2766dc22c2907f6113','v','TABLE(result text, status text)'),
    ('public.list_due_patient_native_push_deliveries()','daece61e3de5c26aef7dc979a50fb705','s',
      'TABLE(notification_id uuid, device_id uuid)')
  ) as expected(signature,body_hash,volatility,result_type)
  loop
    v_function:=pg_catalog.to_regprocedure(v_contract.signature);
    if v_function is null or not exists(select 1 from pg_catalog.pg_proc p
      where p.oid=v_function and p.prosecdef and p.provolatile::text=v_contract.volatility
        and p.proconfig=array['search_path=""']::text[]
        and pg_catalog.pg_get_function_result(p.oid)=v_contract.result_type
        and p.proargnames[1:p.pronargs]=case p.proname
          when 'claim_patient_native_push_delivery' then array['p_notification_id','p_device_id','p_mode']::text[]
          when 'finalize_patient_native_push_delivery' then array['p_delivery_id','p_claim_token','p_attempt_count','p_failure_class','p_http_status','p_error_code','p_provider_message_id','p_device_updated_at','p_retry_after_ms']::text[]
          else array[]::text[] end
        and p.prolang=(select oid from pg_catalog.pg_language where lanname=case when p.proname='list_due_patient_native_push_deliveries' then 'sql' else 'plpgsql' end)
        and ((p.proname='finalize_patient_native_push_delivery' and p.pronargdefaults=1
          and pg_catalog.pg_get_expr(p.proargdefaults,0)='NULL::bigint')
          or (p.proname<>'finalize_patient_native_push_delivery' and p.pronargdefaults=0))
        and pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n'))=v_contract.body_hash)
      or not pg_catalog.has_function_privilege('service_role',v_function,'EXECUTE')
      or pg_catalog.has_function_privilege('anon',v_function,'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated',v_function,'EXECUTE') then
      raise exception 'Native stale recovery preflight: RPC % differs from the reviewed contract.',v_contract.signature;
    end if;
  end loop;
  if not exists(select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid
    where t.tgrelid='public.patient_notification_native_push_deliveries'::regclass
      and t.tgname='patient_native_push_deliveries_set_updated_at' and not t.tgisinternal
      and t.tgenabled='O' and t.tgtype=19 and t.tgqual is null
      and p.oid=pg_catalog.to_regprocedure('public.set_patient_native_push_deliveries_updated_at()')
      and p.proconfig=array['search_path=""']::text[]
      and pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n'))='dbd8a5d98dcc1982bcbb63ec828f0867') then
    raise exception 'Native stale recovery preflight: ledger updated_at trigger differs from the reviewed contract.';
  end if;
  if pg_catalog.to_regprocedure('public.recover_stale_patient_native_push_deliveries()') is not null
     or pg_catalog.to_regclass('public.patient_native_push_stale_processing_idx') is not null then
    raise exception 'Native stale recovery preflight: recovery capability already exists.';
  end if;
  if pg_catalog.to_regclass('cron.job') is not null then
    if exists(select 1 from cron.job where jobname='patient-native-push-stale-recovery') then
      raise exception 'Native stale recovery preflight: recovery cron identity already exists.';
    end if;
  end if;
end;
$preflight$;

alter table public.patient_notification_native_push_deliveries
  add column recovery_at timestamptz,
  add column recovery_reason text,
  drop constraint patient_native_push_deliveries_status_check,
  drop constraint patient_native_push_failure_class_check,
  drop constraint patient_native_push_deliveries_sent_state_check;
alter table public.patient_notification_native_push_deliveries
  add constraint patient_native_push_deliveries_status_check
    check(status in ('processing','sent','failed','disabled_token','delivery_unknown')),
  add constraint patient_native_push_failure_class_check check(last_failure_class is null or (
    status in ('failed','disabled_token','delivery_unknown')
    and last_failure_class in ('permanent_device','confirmed_transient','non_retryable','unknown_outcome'))),
  -- Unknown is not acceptance. Preserve a historical sent_at as evidence if present.
  add constraint patient_native_push_deliveries_sent_state_check check(
    (status='sent' and sent_at is not null) or status='delivery_unknown'
    or (status not in ('sent','delivery_unknown') and sent_at is null)),
  add constraint patient_native_push_recovery_metadata_check check(
    (status='delivery_unknown' and recovery_at is not null and recovery_reason is not null
      and recovery_reason='stale_processing_unknown_outcome' and next_attempt_at is null)
    or (status<>'delivery_unknown' and recovery_at is null and recovery_reason is null));
comment on column public.patient_notification_native_push_deliveries.recovery_reason is
  'Terminal ambiguity, not a failed or accepted provider outcome. Never resend solely because of delivery_unknown.';
create index patient_native_push_stale_processing_idx
on public.patient_notification_native_push_deliveries(attempted_at,id) where status='processing';

create function public.recover_stale_patient_native_push_deliveries()
returns integer language plpgsql security definer set search_path = ''
as $recovery$
declare
  v_candidate record;
  v_changed integer;
  v_recovered integer:=0;
begin
  for v_candidate in
    select delivery.id from public.patient_notification_native_push_deliveries as delivery
    where delivery.status='processing'
      and delivery.attempted_at <= pg_catalog.clock_timestamp()-interval '10 minutes'
    order by delivery.attempted_at,delivery.id
    limit 50
    for update of delivery skip locked
  loop
    update public.patient_notification_native_push_deliveries as delivery
    set status='delivery_unknown',next_attempt_at=null,recovery_at=pg_catalog.clock_timestamp(),
      recovery_reason='stale_processing_unknown_outcome'
    where delivery.id=v_candidate.id and delivery.status='processing'
      and delivery.attempted_at <= pg_catalog.clock_timestamp()-interval '10 minutes';
    get diagnostics v_changed=row_count;
    v_recovered:=v_recovered+v_changed;
  end loop;
  return v_recovered;
end;
$recovery$;
revoke all on function public.recover_stale_patient_native_push_deliveries() from public,anon,authenticated,service_role;
grant execute on function public.recover_stale_patient_native_push_deliveries() to postgres;

-- Both catalog operations are transactional: no committed active recovery job.
-- If inactive creation is unsupported, install no recovery job at all.
do $scheduler$
declare v_job bigint; v_username text;
begin
  if pg_catalog.to_regclass('cron.job') is not null
     and pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is not null
     and pg_catalog.to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is not null then
    v_job:=cron.schedule('patient-native-push-stale-recovery','* * * * *',
      'select public.recover_stale_patient_native_push_deliveries();');
    select username into strict v_username from cron.job where jobid=v_job;
    perform cron.alter_job(v_job,active:=false);
    if not exists(select 1 from cron.job where jobid=v_job and jobname='patient-native-push-stale-recovery' and not active
      and username=v_username and database=pg_catalog.current_database()
      and schedule='* * * * *' and command='select public.recover_stale_patient_native_push_deliveries();') then
      raise exception 'Native stale recovery: inactive cron installation could not be verified.';
    end if;
  else
    raise notice 'Native stale recovery: no recovery cron job installed; inactive-job capability unavailable.';
  end if;
end;
$scheduler$;
notify pgrst,'reload schema';
commit;
