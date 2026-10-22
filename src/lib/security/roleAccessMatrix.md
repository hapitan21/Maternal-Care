# Role Access Matrix

This is a target-behavior checklist, not a claim about the current Supabase policies. Confirm each expectation against existing product workflows before changing any grant or policy. Test both allowed and denied access.

| Data or operation | Admin | Doctor | Staff | Patient |
| --- | --- | --- | --- | --- |
| Own account/profile | Authorized administration | Own profile | Own profile | Own profile |
| User and role administration | Authorized Admin functions only | Deny | Deny | Deny |
| Patient profiles | Authorized clinic administration | Assigned/authorized patients | Clinic workflows currently assigned to Staff | Own profile only |
| Appointments | Authorized administration | Own/assigned appointments | Clinic-wide appointment visibility and current Staff actions | Own appointments only |
| Doctor availability | Authorized administration | Read/update own schedule | Read availability needed for booking; cannot change Doctor schedule | Only availability exposed by the existing booking flow |
| Clinical records/forms | Authorized access only | Assigned/authorized clinical workflow | Existing Staff assessment workflows only | Own records through intended patient features |
| Audit history | Access according to audit policy | Deny unless explicitly authorized | Deny unless explicitly authorized | Deny |
| Unauthenticated access | Deny protected data and writes | Deny | Deny | Deny |

## Required negative checks

- A user cannot change their role by editing browser state or a request payload.
- A Patient cannot read another Patient's profile, appointment, or clinical record by substituting an ID.
- A Doctor cannot access restricted records belonging to another Doctor by changing a URL, query, or request body.
- Staff can perform the existing clinic-wide appointment and assessment actions but cannot change Doctor availability or use Admin-only operations.
- Non-admin roles cannot read or modify protected audit history.
- Signed-out requests cannot read protected rows or perform protected writes.

## Evidence to record

Record environment, test role, synthetic fixture identifiers, operation, expected result, actual result, and date. Do not record passwords, tokens, patient details, or production identifiers.
