begin;

do $preflight$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_definition
    where constraint_definition.contype = 'f'
      and constraint_definition.conrelid = 'public.schedule'::pg_catalog.regclass
      and constraint_definition.confrelid = 'public.patients'::pg_catalog.regclass
      and constraint_definition.convalidated
      and constraint_definition.conkey = array[
        (
          select attribute.attnum
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = 'public.schedule'::pg_catalog.regclass
            and attribute.attname = 'patient_id'
            and not attribute.attisdropped
        )
      ]::smallint[]
      and constraint_definition.confkey = array[
        (
          select attribute.attnum
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = 'public.patients'::pg_catalog.regclass
            and attribute.attname = 'id'
            and not attribute.attisdropped
        )
      ]::smallint[]
  ) then
    raise exception
      'Expected validated foreign key public.schedule(patient_id) -> public.patients(id).';
  end if;
end;
$preflight$;

drop policy if exists "Active Doctors can upload medical record PDFs"
  on storage.objects;

create policy "Active Doctors can upload medical record PDFs"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'medical-records'
  and pg_catalog.cardinality(storage.foldername(name)) = 3
  and (storage.foldername(name))[3] in ('laboratory', 'ultrasound')
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''::text))
      ) = 'doctor'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''::text))
      ) = 'active'
  )
  and exists (
    select 1
    from public.schedule as appointment
    where appointment.id::text = (storage.foldername(name))[2]
      and appointment.patient_id::text = (storage.foldername(name))[1]
  )
);

commit;
