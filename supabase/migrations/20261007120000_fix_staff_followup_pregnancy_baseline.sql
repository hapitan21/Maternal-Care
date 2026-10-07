-- Review only; do not apply automatically.
-- Preserve the installed RPC's exact signature, authorization, metadata and GA
-- anchor algorithm. Replace only its two confirmed legacy field projections.
-- An unrecognized installed definition fails closed instead of being recreated
-- from assumptions about its return types or authorization implementation.
begin;

do $migration$
declare
  v_function oid := pg_catalog.to_regprocedure('public.get_staff_followup_baseline(uuid)');
  v_definition text;
  v_original text;
  v_before record;
  v_after record;
  v_edd_expression text;
  v_risk_expression text;
  v_eligible_sql text;
  v_edd_sql text;
  v_risk_sql text;
begin
  if v_function is null then
    raise exception 'Staff baseline preflight: existing get_staff_followup_baseline(uuid) is required.';
  end if;

  select p.proowner, p.proacl, p.proargnames, p.proallargtypes, p.proargmodes,
         p.prorettype, p.proretset, p.prosecdef, p.proconfig, p.provolatile,
         p.proparallel, p.proleakproof
    into v_before
  from pg_catalog.pg_proc as p where p.oid = v_function;
  if not v_before.prosecdef or not v_before.proretset
     or v_before.proargnames is distinct from array[
       'p_appointment_id', 'source_record_id', 'source_schedule_id',
       'source_visit_type', 'source_visit_date', 'gestational_age',
       'expected_delivery_date', 'pregnancy_status', 'gestational_age_anchor',
       'gestational_age_anchor_date'
     ]::text[]
     or not exists (
       select 1 from pg_catalog.unnest(v_before.proconfig) as setting(value)
       where pg_catalog.regexp_replace(setting.value, '[[:space:]"]', '', 'g')
             = 'search_path=pg_catalog,public'
     ) then
    raise exception 'Staff baseline preflight: signature or SECURITY DEFINER/search_path contract differs.';
  end if;

  v_original := pg_catalog.pg_get_functiondef(v_function);
  if v_original not like '%v_patient_id%'
     or (select pg_catalog.count(*) from pg_catalog.regexp_matches(
       v_original, 'mr[.]form_data[[:space:]]*->>[[:space:]]*''expectedDeliveryDate''', 'g')) <> 1
     or (select pg_catalog.count(*) from pg_catalog.regexp_matches(
       v_original, 'mr[.]form_data[[:space:]]*->>[[:space:]]*''pregnancyStatus''', 'g')) <> 1 then
    raise exception 'Staff baseline preflight: expected single EDD/risk projections and resolved v_patient_id are required. Review the installed definition.';
  end if;
  v_edd_expression := (pg_catalog.regexp_match(
    v_original, 'mr[.]form_data[[:space:]]*->>[[:space:]]*''expectedDeliveryDate'''))[1];
  v_risk_expression := (pg_catalog.regexp_match(
    v_original, 'mr[.]form_data[[:space:]]*->>[[:space:]]*''pregnancyStatus'''))[1];

  -- Same completed clinical-visit flags used by the existing visit workflow.
  -- Both per-field scans are confined to the schedule-resolved Patient.
  v_eligible_sql := $eligible$
    select baseline.id, baseline.uploaded_at, baseline.form_data
    from public.medical_records as baseline
    where baseline.patient_id = v_patient_id
      and baseline.schedule_id is distinct from p_appointment_id
      and pg_catalog.lower(pg_catalog.btrim(coalesce(
        baseline.form_data ->> 'recordStatus', baseline.form_data ->> 'record_status', 'completed'
      ))) = 'completed'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(
        baseline.form_data ->> 'isDraft', baseline.form_data ->> 'is_draft', 'false'
      ))) not in ('true', '1', 'yes')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(
        baseline.form_data ->> 'deleted', 'false'
      ))) not in ('true', '1', 'yes')
      and pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(coalesce(
        nullif(baseline.form_data ->> 'visitFormType', ''),
        nullif(baseline.type, ''), baseline.title, ''
      ))), '[[:space:]_-]+', '', 'g') in (
        'initial', 'initialvisit', 'initialconsultation',
        'followup', 'followupvisit', 'followupconsultation'
      )
  $eligible$;

  v_edd_sql := pg_catalog.format($edd$
    coalesce(
      (with eligible as (%s)
       select pg_catalog.btrim(eligible.form_data ->> 'expectedDeliveryDate', E' \t\r\n')
       from eligible
       where pg_catalog.jsonb_typeof(eligible.form_data -> 'expectedDeliveryDate') = 'string'
         and pg_catalog.lower(pg_catalog.btrim(eligible.form_data ->> 'expectedDeliveryDate', E' \t\r\n'))
             not in ('', '-', 'not provided', 'not recorded', 'n/a', 'na', 'none', 'null', 'undefined')
       order by eligible.uploaded_at desc nulls last, eligible.id desc
       limit 1),
      (select history.expected_delivery_date::text
       from public.patient_obstetric_history as history
       where history.patient_id = v_patient_id and history.expected_delivery_date is not null
       order by history.updated_at desc nulls last, history.created_at desc nulls last, history.id desc
       limit 1),
      (select patient.expected_delivery_date::text from public.patients as patient
       where patient.id = v_patient_id),
      ''
    )
  $edd$, v_eligible_sql);

  v_risk_sql := pg_catalog.format($risk$
    (select case pg_catalog.lower(pg_catalog.regexp_replace(resolved.value, '[[:space:]_-]+', ' ', 'g'))
       when 'low' then 'Low Risk' when 'low risk' then 'Low Risk'
       when 'moderate' then 'Moderate Risk' when 'moderate risk' then 'Moderate Risk'
       when 'high' then 'High Risk' when 'high risk' then 'High Risk'
       else resolved.value
     end
     from (select coalesce(
       (with eligible as (%s)
        select pg_catalog.btrim(eligible.form_data ->> field.key, E' \t\r\n')
        from eligible cross join (values
          ('riskLevel', 1), ('pregnancyStatus', 2), ('pregnancy_status', 3)
        ) as field(key, priority)
        where pg_catalog.jsonb_typeof(eligible.form_data -> field.key) = 'string'
          and pg_catalog.lower(pg_catalog.btrim(eligible.form_data ->> field.key, E' \t\r\n'))
              not in ('', '-', 'not provided', 'not recorded', 'n/a', 'na', 'none', 'null', 'undefined')
        order by field.priority, eligible.uploaded_at desc nulls last, eligible.id desc
        limit 1),
       (select pg_catalog.btrim(patient.risk_level, E' \t\r\n')
        from public.patients as patient
        where patient.id = v_patient_id
          and pg_catalog.lower(pg_catalog.btrim(patient.risk_level, E' \t\r\n'))
              not in ('', '-', 'not provided', 'not recorded', 'n/a', 'na', 'none', 'null', 'undefined')),
       ''
     ) as value) as resolved)
  $risk$, v_eligible_sql);

  -- pg_get_functiondef supplies CREATE OR REPLACE and the existing function's
  -- actual return types and attributes. No helper RPC, grant or policy is added.
  v_definition := pg_catalog.replace(v_original, v_edd_expression, v_edd_sql);
  v_definition := pg_catalog.replace(v_definition, v_risk_expression, v_risk_sql);
  execute v_definition;

  select p.proowner, p.proacl, p.proargnames, p.proallargtypes, p.proargmodes,
         p.prorettype, p.proretset, p.prosecdef, p.proconfig, p.provolatile,
         p.proparallel, p.proleakproof
    into v_after
  from pg_catalog.pg_proc as p where p.oid = v_function;
  if v_after is distinct from v_before then
    raise exception 'Staff baseline postflight: owner, grants, signature or security attributes changed.';
  end if;
end;
$migration$;

commit;
