begin;

revoke all privileges
on table public.patient_native_push_devices
from service_role;

grant select, update
on table public.patient_native_push_devices
to service_role;

commit;