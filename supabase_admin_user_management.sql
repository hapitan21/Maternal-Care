-- ============================================================
-- REVIEW ONLY: Admin User Management reads and status controls
-- Do not execute automatically from the application.
-- ============================================================

begin;

-- Preflight: stop before replacing functions when the required contract is absent.
do $preflight$
declare
  missing_objects text;
begin
  with required_tables(table_name) as (
    values
      ('profiles'),
      ('patients'),
      ('audit_logs'),
      ('doctor_personal_information'),
      ('doctor_professional_information'),
      ('staff_personal_information'),
      ('staff_professional_information')
  ), missing_tables as (
    select 'table public.' || required.table_name as object_name
    from required_tables as required
    where pg_catalog.to_regclass('public.' || required.table_name) is null
  ), required_columns(table_name, column_name) as (
    values
      ('profiles', 'id'), ('profiles', 'full_name'), ('profiles', 'email'),
      ('profiles', 'contact_number'), ('profiles', 'role'),
      ('profiles', 'account_status'), ('profiles', 'created_at'),
      ('profiles', 'deactivated_at'), ('profiles', 'deactivated_by'),
      ('profiles', 'reactivated_at'), ('profiles', 'reactivated_by'),
      ('patients', 'id'), ('patients', 'patient_id'),
      ('patients', 'control_number'), ('patients', 'full_name'),
      ('patients', 'contact_number'), ('patients', 'user_id'),
      ('patients', 'status'), ('patients', 'account_status'),
      ('patients', 'archived_at'), ('patients', 'created_at'),
      ('patients', 'updated_at'),
      ('patients', 'activated_at'), ('patients', 'activated_by'),
      ('patients', 'deactivated_at'), ('patients', 'deactivated_by'),
      ('doctor_personal_information', 'id'),
      ('doctor_personal_information', 'auth_user_id'),
      ('doctor_personal_information', 'full_name'),
      ('doctor_personal_information', 'created_at'),
      ('doctor_professional_information', 'id'),
      ('doctor_professional_information', 'auth_user_id'),
      ('doctor_professional_information', 'doctor_code'),
      ('doctor_professional_information', 'contact_number'),
      ('doctor_professional_information', 'board_certification'),
      ('doctor_professional_information', 'license_number'),
      ('doctor_professional_information', 'clinic_hospital_name'),
      ('doctor_professional_information', 'created_at'),
      ('staff_personal_information', 'id'),
      ('staff_personal_information', 'auth_user_id'),
      ('staff_personal_information', 'full_name'),
      ('staff_personal_information', 'created_at'),
      ('staff_professional_information', 'id'),
      ('staff_professional_information', 'auth_user_id'),
      ('staff_professional_information', 'staff_code'),
      ('staff_professional_information', 'contact_number'),
      ('staff_professional_information', 'position'),
      ('staff_professional_information', 'created_at')
  ), missing_columns as (
    select 'column public.' || required.table_name || '.' || required.column_name as object_name
    from required_columns as required
    where not exists (
      select 1
      from information_schema.columns as columns
      where columns.table_schema = 'public'
        and columns.table_name = required.table_name
        and columns.column_name = required.column_name
    )
  ), missing_function as (
    select 'function public.record_audit_event(text,text,text,text,text,jsonb,uuid)' as object_name
    where pg_catalog.to_regprocedure(
      'public.record_audit_event(text,text,text,text,text,jsonb,uuid)'
    ) is null
  ), missing as (
    select object_name from missing_tables
    union all
    select object_name from missing_columns
    union all
    select object_name from missing_function
  )
  select pg_catalog.string_agg(missing.object_name, ', ' order by missing.object_name)
  into missing_objects
  from missing;

  if missing_objects is not null then
    raise exception 'User Management preflight failed. Missing objects: %', missing_objects;
  end if;
end;
$preflight$;

create or replace function public.admin_user_management_assert_active_admin()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_role, v_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if not found or v_role is distinct from 'admin' or v_status is distinct from 'active' then
    raise exception 'An active Admin account is required.' using errcode = '42501';
  end if;
end;
$function$;

create or replace function public.admin_get_user_management_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.admin_user_management_assert_active_admin();

  select pg_catalog.jsonb_build_object(
    'patients', pg_catalog.jsonb_build_object(
      'total', count(*) filter (where patient.archived_at is null),
      'active', count(*) filter (
        where patient.archived_at is null
          and patient_profile.id is not null
          and pg_catalog.lower(pg_catalog.btrim(coalesce(patient_profile.account_status, ''::text))) = 'active'
      ),
      'inactive', count(*) filter (
        where patient.archived_at is null
          and patient_profile.id is not null
          and pg_catalog.lower(pg_catalog.btrim(coalesce(patient_profile.account_status, ''::text))) in ('inactive', 'deactivated', 'suspended')
      ),
      'not_linked', count(*) filter (
        where patient.archived_at is null and patient_profile.id is null
      )
    ),
    'doctors', pg_catalog.jsonb_build_object(
      'total', (select count(*) from public.profiles as profile where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'),
      'active', (select count(*) from public.profiles as profile where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor' and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'),
      'inactive', (select count(*) from public.profiles as profile where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor' and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) in ('inactive', 'deactivated', 'suspended'))
    ),
    'staff', pg_catalog.jsonb_build_object(
      'total', (select count(*) from public.profiles as profile where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'),
      'active', (select count(*) from public.profiles as profile where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff' and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'),
      'inactive', (select count(*) from public.profiles as profile where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff' and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) in ('inactive', 'deactivated', 'suspended'))
    )
  )
  into v_result
  from public.patients as patient
  left join public.profiles as patient_profile
    on patient_profile.id = patient.user_id
   and pg_catalog.lower(pg_catalog.btrim(coalesce(patient_profile.role, ''::text))) = 'patient';

  return v_result;
end;
$function$;

create or replace function public.admin_get_user_management_page(
  p_user_type text,
  p_search text default '',
  p_status text default 'all',
  p_secondary_filter text default 'all',
  p_sort text default 'date',
  p_page integer default 1,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_type text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_user_type, ''::text)));
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''::text)));
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, 'all'::text)));
  v_secondary text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_secondary_filter, 'all'::text)));
  v_sort text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_sort, 'date'::text)));
  v_page_size integer := least(greatest(coalesce(p_page_size, 10), 5), 50);
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_options jsonb := '[]'::jsonb;
begin
  perform public.admin_user_management_assert_active_admin();

  if v_type not in ('patients', 'doctors', 'staff') then
    raise exception 'User type must be patients, doctors, or staff.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_search) > 200 then
    raise exception 'Search text must not exceed 200 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_secondary) > 160 then
    raise exception 'Secondary filter must not exceed 160 characters.' using errcode = '22023';
  end if;
  if v_type = 'patients' and v_status not in ('all', 'active', 'inactive', 'not_linked', 'archived') then
    raise exception 'Unsupported Patient account-status filter.' using errcode = '22023';
  end if;
  if v_type in ('doctors', 'staff') and v_status not in ('all', 'active', 'inactive') then
    raise exception 'Unsupported clinic account-status filter.' using errcode = '22023';
  end if;
  if v_sort not in ('date', 'name', 'status') then
    raise exception 'Unsupported User Management sort.' using errcode = '22023';
  end if;

  if v_type = 'patients' then
    with eligible as (
      select patient.id,
        coalesce(nullif(pg_catalog.btrim(patient.patient_id), ''), nullif(pg_catalog.btrim(patient.control_number), ''), pg_catalog.left(patient.id::text, 8)) as display_id,
        coalesce(nullif(pg_catalog.btrim(patient.full_name), ''), 'Unnamed Patient') as full_name,
        nullif(pg_catalog.btrim(patient.contact_number), '') as contact_number,
        patient.user_id,
        linked_profile.id as linked_profile_id,
        linked_profile.email as linked_email,
        case when linked_profile.id is null then 'not_linked' else pg_catalog.lower(pg_catalog.btrim(coalesce(linked_profile.account_status, ''::text))) end as account_status,
        case when linked_profile.id is null then 'not_linked' else 'linked' end as link_status,
        pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text))) as record_status,
        patient.account_status as patient_record_account_status,
        patient.archived_at,
        patient.created_at
      from public.patients as patient
      left join public.profiles as linked_profile
        on linked_profile.id = patient.user_id
       and pg_catalog.lower(pg_catalog.btrim(coalesce(linked_profile.role, ''::text))) = 'patient'
    ), filtered as (
      select * from eligible
      where ((v_status = 'archived' and archived_at is not null) or (v_status <> 'archived' and archived_at is null))
        and (
          v_status in ('all', 'archived')
          or (v_status = 'inactive' and account_status in ('inactive', 'deactivated', 'suspended'))
          or (v_status <> 'inactive' and account_status = v_status)
        )
        and (v_search = '' or pg_catalog.lower(pg_catalog.concat_ws(' ', display_id, full_name, contact_number, linked_email)) like '%' || v_search || '%')
    )
    select count(*) into v_total from filtered;

    v_page := least(v_page, greatest(1, pg_catalog.ceil(v_total::numeric / v_page_size)::integer));

    with eligible as (
      select patient.id,
        coalesce(nullif(pg_catalog.btrim(patient.patient_id), ''), nullif(pg_catalog.btrim(patient.control_number), ''), pg_catalog.left(patient.id::text, 8)) as display_id,
        coalesce(nullif(pg_catalog.btrim(patient.full_name), ''), 'Unnamed Patient') as full_name,
        nullif(pg_catalog.btrim(patient.contact_number), '') as contact_number,
        patient.user_id, linked_profile.id as linked_profile_id,
        linked_profile.email as linked_email,
        case when linked_profile.id is null then 'not_linked' else pg_catalog.lower(pg_catalog.btrim(coalesce(linked_profile.account_status, ''::text))) end as account_status,
        case when linked_profile.id is null then 'not_linked' else 'linked' end as link_status,
        pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text))) as record_status,
        patient.account_status as patient_record_account_status,
        patient.archived_at, patient.created_at
      from public.patients as patient
      left join public.profiles as linked_profile on linked_profile.id = patient.user_id and pg_catalog.lower(pg_catalog.btrim(coalesce(linked_profile.role, ''::text))) = 'patient'
    ), filtered as (
      select * from eligible
      where ((v_status = 'archived' and archived_at is not null) or (v_status <> 'archived' and archived_at is null))
        and (
          v_status in ('all', 'archived')
          or (v_status = 'inactive' and account_status in ('inactive', 'deactivated', 'suspended'))
          or (v_status <> 'inactive' and account_status = v_status)
        )
        and (v_search = '' or pg_catalog.lower(pg_catalog.concat_ws(' ', display_id, full_name, contact_number, linked_email)) like '%' || v_search || '%')
    ), page_rows as (
      select * from filtered
      order by
        case when v_sort = 'name' then pg_catalog.lower(full_name) end asc,
        case when v_sort = 'status' then account_status end asc,
        case when v_sort = 'date' then created_at end desc,
        created_at desc, id
      limit v_page_size offset (v_page - 1) * v_page_size
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page_rows)), '[]'::jsonb) into v_rows from page_rows;
  else
    with eligible as (
      select profile.id,
        case when v_type = 'doctors' then 'doctor' else 'staff' end as role,
        coalesce(nullif(pg_catalog.btrim(case when v_type = 'doctors' then doctor_personal.full_name else staff_personal.full_name end), ''), nullif(pg_catalog.btrim(profile.full_name), ''), nullif(pg_catalog.btrim(profile.email), ''), 'Unnamed User') as full_name,
        nullif(pg_catalog.btrim(profile.email), '') as email,
        coalesce(nullif(pg_catalog.btrim(profile.contact_number), ''), nullif(pg_catalog.btrim(case when v_type = 'doctors' then doctor_professional.contact_number else staff_professional.contact_number end), '')) as contact_number,
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) as account_status,
        case when v_type = 'doctors' then coalesce(nullif(pg_catalog.btrim(doctor_professional.doctor_code), ''), pg_catalog.left(profile.id::text, 8)) else coalesce(nullif(pg_catalog.btrim(staff_professional.staff_code), ''), pg_catalog.left(profile.id::text, 8)) end as display_id,
        case when v_type = 'doctors' then nullif(pg_catalog.btrim(doctor_professional.board_certification), '') else nullif(pg_catalog.btrim(staff_professional.position), '') end as secondary_text,
        doctor_professional.license_number,
        doctor_professional.clinic_hospital_name,
        profile.created_at
      from public.profiles as profile
      left join lateral (select personal.* from public.doctor_personal_information as personal where personal.auth_user_id = profile.id order by personal.created_at desc, personal.id desc limit 1) as doctor_personal on v_type = 'doctors'
      left join lateral (select professional.* from public.doctor_professional_information as professional where professional.auth_user_id = profile.id order by professional.created_at desc, professional.id desc limit 1) as doctor_professional on v_type = 'doctors'
      left join lateral (select personal.* from public.staff_personal_information as personal where personal.auth_user_id = profile.id order by personal.created_at desc, personal.id desc limit 1) as staff_personal on v_type = 'staff'
      left join lateral (select professional.* from public.staff_professional_information as professional where professional.auth_user_id = profile.id order by professional.created_at desc, professional.id desc limit 1) as staff_professional on v_type = 'staff'
      where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = case when v_type = 'doctors' then 'doctor' else 'staff' end
    ), filtered as (
      select * from eligible
      where (
          v_status = 'all'
          or (v_status = 'inactive' and account_status in ('inactive', 'deactivated', 'suspended'))
          or (v_status <> 'inactive' and account_status = v_status)
        )
        and (v_secondary = 'all' or pg_catalog.lower(coalesce(secondary_text, '')) = v_secondary)
        and (v_search = '' or pg_catalog.lower(pg_catalog.concat_ws(' ', display_id, full_name, email, contact_number, secondary_text)) like '%' || v_search || '%')
    )
    select count(*) into v_total from filtered;

    v_page := least(v_page, greatest(1, pg_catalog.ceil(v_total::numeric / v_page_size)::integer));

    with eligible as (
      select profile.id, case when v_type = 'doctors' then 'doctor' else 'staff' end as role,
        coalesce(nullif(pg_catalog.btrim(case when v_type = 'doctors' then doctor_personal.full_name else staff_personal.full_name end), ''), nullif(pg_catalog.btrim(profile.full_name), ''), nullif(pg_catalog.btrim(profile.email), ''), 'Unnamed User') as full_name,
        nullif(pg_catalog.btrim(profile.email), '') as email,
        coalesce(nullif(pg_catalog.btrim(profile.contact_number), ''), nullif(pg_catalog.btrim(case when v_type = 'doctors' then doctor_professional.contact_number else staff_professional.contact_number end), '')) as contact_number,
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) as account_status,
        case when v_type = 'doctors' then coalesce(nullif(pg_catalog.btrim(doctor_professional.doctor_code), ''), pg_catalog.left(profile.id::text, 8)) else coalesce(nullif(pg_catalog.btrim(staff_professional.staff_code), ''), pg_catalog.left(profile.id::text, 8)) end as display_id,
        case when v_type = 'doctors' then nullif(pg_catalog.btrim(doctor_professional.board_certification), '') else nullif(pg_catalog.btrim(staff_professional.position), '') end as secondary_text,
        doctor_professional.license_number, doctor_professional.clinic_hospital_name, profile.created_at
      from public.profiles as profile
      left join lateral (select personal.* from public.doctor_personal_information as personal where personal.auth_user_id = profile.id order by personal.created_at desc, personal.id desc limit 1) as doctor_personal on v_type = 'doctors'
      left join lateral (select professional.* from public.doctor_professional_information as professional where professional.auth_user_id = profile.id order by professional.created_at desc, professional.id desc limit 1) as doctor_professional on v_type = 'doctors'
      left join lateral (select personal.* from public.staff_personal_information as personal where personal.auth_user_id = profile.id order by personal.created_at desc, personal.id desc limit 1) as staff_personal on v_type = 'staff'
      left join lateral (select professional.* from public.staff_professional_information as professional where professional.auth_user_id = profile.id order by professional.created_at desc, professional.id desc limit 1) as staff_professional on v_type = 'staff'
      where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = case when v_type = 'doctors' then 'doctor' else 'staff' end
    ), filtered as (
      select * from eligible
      where (
          v_status = 'all'
          or (v_status = 'inactive' and account_status in ('inactive', 'deactivated', 'suspended'))
          or (v_status <> 'inactive' and account_status = v_status)
        )
        and (v_secondary = 'all' or pg_catalog.lower(coalesce(secondary_text, '')) = v_secondary)
        and (v_search = '' or pg_catalog.lower(pg_catalog.concat_ws(' ', display_id, full_name, email, contact_number, secondary_text)) like '%' || v_search || '%')
    ), page_rows as (
      select * from filtered
      order by case when v_sort = 'name' then pg_catalog.lower(full_name) end asc,
        case when v_sort = 'status' then account_status end asc,
        case when v_sort = 'date' then created_at end desc,
        created_at desc, id
      limit v_page_size offset (v_page - 1) * v_page_size
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page_rows)), '[]'::jsonb) into v_rows from page_rows;

    with option_rows as (
      select distinct case when v_type = 'doctors' then nullif(pg_catalog.btrim(professional.board_certification), '') else nullif(pg_catalog.btrim(staff.position), '') end as value
      from public.profiles as profile
      left join public.doctor_professional_information as professional on professional.auth_user_id = profile.id and v_type = 'doctors'
      left join public.staff_professional_information as staff on staff.auth_user_id = profile.id and v_type = 'staff'
      where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = case when v_type = 'doctors' then 'doctor' else 'staff' end
    )
    select coalesce(pg_catalog.jsonb_agg(value order by value) filter (where value is not null), '[]'::jsonb) into v_options from option_rows;
  end if;

  return pg_catalog.jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'page_size', v_page_size, 'filter_options', v_options);
end;
$function$;

create or replace function public.admin_get_user_management_detail(p_user_type text, p_target_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_type text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_user_type, ''::text)));
  v_result jsonb;
begin
  perform public.admin_user_management_assert_active_admin();
  if p_target_id is null or v_type not in ('patient', 'doctor', 'staff') then
    raise exception 'A valid User Management target is required.' using errcode = '22023';
  end if;

  if v_type = 'patient' then
    select pg_catalog.jsonb_build_object(
      'id', patient.id, 'type', 'patient',
      'display_id', coalesce(nullif(pg_catalog.btrim(patient.patient_id), ''), nullif(pg_catalog.btrim(patient.control_number), ''), pg_catalog.left(patient.id::text, 8)),
      'full_name', coalesce(nullif(pg_catalog.btrim(patient.full_name), ''), 'Unnamed Patient'),
      'contact_number', nullif(pg_catalog.btrim(patient.contact_number), ''),
      'email', linked_profile.email,
      'linked_profile_id', linked_profile.id,
      'link_status', case when linked_profile.id is null then 'not_linked' else 'linked' end,
      'account_status', case when linked_profile.id is null then 'not_linked' else pg_catalog.lower(pg_catalog.btrim(coalesce(linked_profile.account_status, ''::text))) end,
      'record_status', pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text))),
      'patient_record_account_status', patient.account_status,
      'created_at', patient.created_at, 'archived_at', patient.archived_at
    ) into v_result
    from public.patients as patient
    left join public.profiles as linked_profile on linked_profile.id = patient.user_id and pg_catalog.lower(pg_catalog.btrim(coalesce(linked_profile.role, ''::text))) = 'patient'
    where patient.id = p_target_id;
  elsif v_type = 'doctor' then
    select pg_catalog.jsonb_build_object(
      'id', profile.id, 'type', 'doctor',
      'display_id', coalesce(nullif(pg_catalog.btrim(professional.doctor_code), ''), pg_catalog.left(profile.id::text, 8)),
      'full_name', coalesce(nullif(pg_catalog.btrim(personal.full_name), ''), nullif(pg_catalog.btrim(profile.full_name), ''), 'Unnamed Doctor'),
      'email', profile.email,
      'contact_number', coalesce(nullif(pg_catalog.btrim(profile.contact_number), ''), nullif(pg_catalog.btrim(professional.contact_number), '')),
      'account_status', pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))),
      'board_certification', professional.board_certification,
      'license_number', professional.license_number,
      'clinic_hospital', professional.clinic_hospital_name,
      'created_at', profile.created_at
    ) into v_result
    from public.profiles as profile
    left join lateral (select row.* from public.doctor_personal_information as row where row.auth_user_id = profile.id order by row.created_at desc, row.id desc limit 1) as personal on true
    left join lateral (select row.* from public.doctor_professional_information as row where row.auth_user_id = profile.id order by row.created_at desc, row.id desc limit 1) as professional on true
    where profile.id = p_target_id and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor';
  else
    select pg_catalog.jsonb_build_object(
      'id', profile.id, 'type', 'staff',
      'display_id', coalesce(nullif(pg_catalog.btrim(professional.staff_code), ''), pg_catalog.left(profile.id::text, 8)),
      'full_name', coalesce(nullif(pg_catalog.btrim(personal.full_name), ''), nullif(pg_catalog.btrim(profile.full_name), ''), 'Unnamed Staff'),
      'email', profile.email,
      'contact_number', coalesce(nullif(pg_catalog.btrim(profile.contact_number), ''), nullif(pg_catalog.btrim(professional.contact_number), '')),
      'account_status', pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))),
      'position', professional.position,
      'created_at', profile.created_at
    ) into v_result
    from public.profiles as profile
    left join lateral (select row.* from public.staff_personal_information as row where row.auth_user_id = profile.id order by row.created_at desc, row.id desc limit 1) as personal on true
    left join lateral (select row.* from public.staff_professional_information as row where row.auth_user_id = profile.id order by row.created_at desc, row.id desc limit 1) as professional on true
    where profile.id = p_target_id and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff';
  end if;

  if v_result is null then
    raise exception 'The selected User Management record was not found.' using errcode = 'P0002';
  end if;
  return v_result;
end;
$function$;

create or replace function public.admin_set_patient_account_status(p_patient_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_patient public.patients%rowtype;
  v_profile public.profiles%rowtype;
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text)));
  v_current text;
  v_next text;
begin
  perform public.admin_user_management_assert_active_admin();
  select * into v_patient from public.patients where id = p_patient_id for update;
  if not found then raise exception 'The selected Patient record was not found.' using errcode = 'P0002'; end if;
  if v_patient.archived_at is not null then raise exception 'Archived Patient records cannot receive login-status changes.' using errcode = '22023'; end if;
  if v_patient.user_id is null then raise exception 'This Patient does not have a linked login account.' using errcode = '22023'; end if;
  select * into v_profile from public.profiles where id = v_patient.user_id for update;
  if not found or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''::text))) <> 'patient' then raise exception 'This Patient does not have a linked Patient profile.' using errcode = '22023'; end if;
  if v_profile.id = auth.uid() then raise exception 'You cannot change your own privileged account status.' using errcode = '22023'; end if;
  v_current := pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.account_status, ''::text)));
  if v_action = 'deactivate' and v_current = 'active' then v_next := 'inactive';
  elsif v_action = 'reactivate' and v_current in ('inactive', 'deactivated', 'suspended') then v_next := 'active';
  elsif v_action = 'activate' and v_current in ('pending', 'pending_activation') then v_next := 'active';
  else raise exception 'The requested Patient account-status transition is not allowed.' using errcode = '22023'; end if;

  update public.profiles as profile set account_status = v_next,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    reactivated_at = case when v_next = 'active' then pg_catalog.now() else profile.reactivated_at end,
    reactivated_by = case when v_next = 'active' then auth.uid() else profile.reactivated_by end
  where profile.id = v_profile.id;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'updated_at') then
    execute 'update public.profiles set updated_at = pg_catalog.now() where id = $1' using v_profile.id;
  end if;
  update public.patients as patient set account_status = v_next,
    activated_at = case when v_next = 'active' then pg_catalog.now() else patient.activated_at end,
    activated_by = case when v_next = 'active' then auth.uid() else patient.activated_by end,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    updated_at = pg_catalog.now()
  where patient.id = v_patient.id;
  perform public.record_audit_event('user_management', v_action, 'patient_account', v_patient.id::text, 'Patient account access status changed by an Administrator.', pg_catalog.jsonb_build_object('previous_status', v_current, 'new_status', v_next), null);
  return pg_catalog.jsonb_build_object('id', v_patient.id, 'profile_id', v_profile.id, 'role', 'patient', 'account_status', v_next, 'action', v_action);
end;
$function$;

create or replace function public.admin_set_doctor_account_status(p_profile_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_profile public.profiles%rowtype; v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text))); v_current text; v_next text;
begin
  perform public.admin_user_management_assert_active_admin();
  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''::text))) <> 'doctor' then raise exception 'The selected Doctor profile was not found.' using errcode = 'P0002'; end if;
  if v_profile.id = auth.uid() then raise exception 'You cannot change your own privileged account status.' using errcode = '22023'; end if;
  v_current := pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.account_status, ''::text)));
  if v_action = 'deactivate' and v_current = 'active' then v_next := 'inactive'; elsif v_action = 'reactivate' and v_current in ('inactive', 'deactivated', 'suspended') then v_next := 'active'; else raise exception 'The requested Doctor account-status transition is not allowed.' using errcode = '22023'; end if;
  update public.profiles as profile set account_status = v_next,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    reactivated_at = case when v_next = 'active' then pg_catalog.now() else profile.reactivated_at end,
    reactivated_by = case when v_next = 'active' then auth.uid() else profile.reactivated_by end
  where profile.id = v_profile.id;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'updated_at') then
    execute 'update public.profiles set updated_at = pg_catalog.now() where id = $1' using v_profile.id;
  end if;
  perform public.record_audit_event('user_management', v_action, 'doctor_account', v_profile.id::text, 'Doctor account access status changed by an Administrator.', pg_catalog.jsonb_build_object('previous_status', v_current, 'new_status', v_next), null);
  return pg_catalog.jsonb_build_object('id', v_profile.id, 'role', 'doctor', 'account_status', v_next, 'action', v_action);
end;
$function$;

create or replace function public.admin_set_staff_account_status(p_profile_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_profile public.profiles%rowtype; v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text))); v_current text; v_next text;
begin
  perform public.admin_user_management_assert_active_admin();
  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''::text))) <> 'staff' then raise exception 'The selected Staff profile was not found.' using errcode = 'P0002'; end if;
  if v_profile.id = auth.uid() then raise exception 'You cannot change your own privileged account status.' using errcode = '22023'; end if;
  v_current := pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.account_status, ''::text)));
  if v_action = 'deactivate' and v_current = 'active' then v_next := 'inactive'; elsif v_action = 'reactivate' and v_current in ('inactive', 'deactivated', 'suspended') then v_next := 'active'; else raise exception 'The requested Staff account-status transition is not allowed.' using errcode = '22023'; end if;
  update public.profiles as profile set account_status = v_next,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    reactivated_at = case when v_next = 'active' then pg_catalog.now() else profile.reactivated_at end,
    reactivated_by = case when v_next = 'active' then auth.uid() else profile.reactivated_by end
  where profile.id = v_profile.id;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'updated_at') then
    execute 'update public.profiles set updated_at = pg_catalog.now() where id = $1' using v_profile.id;
  end if;
  perform public.record_audit_event('user_management', v_action, 'staff_account', v_profile.id::text, 'Staff account access status changed by an Administrator.', pg_catalog.jsonb_build_object('previous_status', v_current, 'new_status', v_next), null);
  return pg_catalog.jsonb_build_object('id', v_profile.id, 'role', 'staff', 'account_status', v_next, 'action', v_action);
end;
$function$;

revoke all on function public.admin_user_management_assert_active_admin() from public, anon, authenticated;
revoke all on function public.admin_get_user_management_summary() from public, anon;
revoke all on function public.admin_get_user_management_page(text, text, text, text, text, integer, integer) from public, anon;
revoke all on function public.admin_get_user_management_detail(text, uuid) from public, anon;
revoke all on function public.admin_set_patient_account_status(uuid, text) from public, anon;
revoke all on function public.admin_set_doctor_account_status(uuid, text) from public, anon;
revoke all on function public.admin_set_staff_account_status(uuid, text) from public, anon;

grant execute on function public.admin_get_user_management_summary() to authenticated;
grant execute on function public.admin_get_user_management_page(text, text, text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_get_user_management_detail(text, uuid) to authenticated;
grant execute on function public.admin_set_patient_account_status(uuid, text) to authenticated;
grant execute on function public.admin_set_doctor_account_status(uuid, text) to authenticated;
grant execute on function public.admin_set_staff_account_status(uuid, text) to authenticated;

notify pgrst, 'reload schema';
commit;

-- Verification (run manually after review and installation):
-- select pg_get_functiondef('public.admin_set_patient_account_status(uuid,text)'::regprocedure);
-- select pg_get_functiondef('public.admin_set_doctor_account_status(uuid,text)'::regprocedure);
-- select pg_get_functiondef('public.admin_set_staff_account_status(uuid,text)'::regprocedure);
-- select public.admin_get_user_management_summary(); -- authenticated active Admin only
-- select public.admin_get_user_management_page('patients', '', 'all', 'all', 'date', 1, 10);
-- Verify a Not Linked Patient is rejected by admin_set_patient_account_status.
-- Verify an active Doctor/Staff can deactivate and the reverse transition requires inactive status.
-- Verify each successful status change creates exactly one user_management audit row.
-- Verify role values are unchanged and auth.users rows remain intact.
-- Verify an inactive or non-Admin caller receives SQLSTATE 42501.

-- Rollback guidance (review dependencies before running):
-- begin;
-- revoke all on function public.admin_get_user_management_summary() from authenticated;
-- revoke all on function public.admin_get_user_management_page(text,text,text,text,text,integer,integer) from authenticated;
-- revoke all on function public.admin_get_user_management_detail(text,uuid) from authenticated;
-- revoke all on function public.admin_set_patient_account_status(uuid,text) from authenticated;
-- revoke all on function public.admin_set_doctor_account_status(uuid,text) from authenticated;
-- revoke all on function public.admin_set_staff_account_status(uuid,text) from authenticated;
-- drop function public.admin_get_user_management_summary();
-- drop function public.admin_get_user_management_page(text,text,text,text,text,integer,integer);
-- drop function public.admin_get_user_management_detail(text,uuid);
-- drop function public.admin_set_patient_account_status(uuid,text);
-- drop function public.admin_set_doctor_account_status(uuid,text);
-- drop function public.admin_set_staff_account_status(uuid,text);
-- drop function public.admin_user_management_assert_active_admin();
-- notify pgrst, 'reload schema';
-- commit;
