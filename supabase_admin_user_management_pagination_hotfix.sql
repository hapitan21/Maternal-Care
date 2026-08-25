-- ============================================================
-- REVIEW ONLY: Admin User Management pagination runtime hotfix
-- Do not execute automatically from the application.
-- ============================================================
--
-- This hotfix replaces only:
-- public.admin_get_user_management_page(
--   text, text, text, text, text, integer, integer
-- )
--
-- It removes invalid pg_catalog qualification from the PostgreSQL
-- GREATEST and LEAST SQL expressions. All other function behavior is copied
-- from the complete reviewed source migration without modification.
--
-- Pre-install capture and verification (run manually):
-- select pg_catalog.pg_get_functiondef(
--   'public.admin_get_user_management_page(text,text,text,text,text,integer,integer)'::pg_catalog.regprocedure
-- );

begin;

do $preflight$
begin
  if pg_catalog.to_regprocedure(
    'public.admin_get_user_management_page(text,text,text,text,text,integer,integer)'
  ) is null then
    raise exception 'Required pagination RPC is not installed.';
  end if;
end;
$preflight$;

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

revoke all on function public.admin_get_user_management_page(
  text, text, text, text, text, integer, integer
) from public, anon;
grant execute on function public.admin_get_user_management_page(
  text, text, text, text, text, integer, integer
) to authenticated;

notify pgrst, 'reload schema';
commit;

-- Post-install verification (run manually as an active Admin):
-- select public.admin_get_user_management_page(
--   'patients', '', 'all', 'all', 'date', 1, 10
-- );
-- select public.admin_get_user_management_page(
--   'doctors', '', 'all', 'all', 'date', 1, 10
-- );
-- select public.admin_get_user_management_page(
--   'staff', '', 'all', 'all', 'date', 1, 10
-- );
-- Confirm every result contains finite positive page/page_size values, a
-- non-negative total, an array of rows, and no GREATEST/LEAST lookup error.
-- Confirm a non-Admin or inactive Admin remains rejected.
--
-- Rollback guidance:
-- Before applying, save the pre-install pg_get_functiondef output above.
-- To roll back, run that captured CREATE OR REPLACE FUNCTION definition inside
-- begin/commit, preserve the authenticated EXECUTE grant, then run:
-- notify pgrst, 'reload schema';

