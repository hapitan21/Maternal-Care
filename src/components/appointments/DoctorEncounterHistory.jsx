import React from 'react';
import { supabase } from '../../lib/supabaseClient';
import { getLogicalSessionIdentity } from '../../lib/roleInactivity';
import { encounterSnapshotsEnabled, hasEncounterManifest, loadDoctorEncounterSnapshot } from '../../lib/doctorEncounterSnapshot';
import { boundedInitialRequest } from '../../lib/doctorInitialIntegration';
import '../../styles/doctor-encounter-history.css';

const visible = value => value == null || value === '' ? 'Not recorded' : typeof value === 'boolean' ? (value ? 'Yes' : 'No')
  : typeof value === 'object' ? JSON.stringify(value) : String(value);
const reproductive = [['age_at_menarche', 'Age at Menarche'], ['menstrual_pattern', 'Menstrual Pattern'], ['cycle_length_days', 'Cycle Length (days)'],
  ['menstruation_duration_days', 'Duration of Menstruation (days)'], ['sexually_active', 'Sexually Active'], ['contraceptive_method', 'Contraceptive Method'],
  ['gravida', 'Gravida (G)'], ['para', 'Para (P)'], ['full_term', 'Full Term (T)'], ['preterm', 'Preterm (P)'],
  ['abortion_miscarriage', 'Abortion/Miscarriage (A)'], ['living_children', 'Living Children (L)'], ['last_menstrual_period', 'Last Menstrual Period'], ['expected_delivery_date', 'Expected Delivery Date']];

function SavedRows({ value }) {
  if (!Array.isArray(value) || !value.length) return <p>Not recorded</p>;
  return <ul>{value.map((item, index) => <li key={index}>{item && typeof item === 'object'
    ? Object.entries(item).filter(([key]) => key !== 'id').map(([key, v]) => `${key.replaceAll('_', ' ')}: ${visible(v)}`).join('; ')
    : visible(item)}</li>)}</ul>;
}

export default function DoctorEncounterHistory({ row = null, patientId, authorizingAppointment = row?.schedule_id, appointments = null, priorInitial = false }) {
  const enabled = encounterSnapshotsEnabled(import.meta.env, supabase);
  const [state, setState] = React.useState(null);
  const [retry, setRetry] = React.useState(0);
  const authorityKey = JSON.stringify(appointments?.map(item => ({ id: item.id, patient_id: item.patient_id, doctor_id: item.doctor_id, status: item.status }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))) ?? null);
  const authorities = React.useMemo(() => JSON.parse(authorityKey), [authorityKey]);
  // Key data by exact row content as well as identity; updates cannot reuse an old snapshot.
  const key = JSON.stringify([patientId, authorizingAppointment, row, authorities, retry]);
  const legacy = !priorInitial && !hasEncounterManifest(row);
  React.useEffect(() => {
    if (!enabled || legacy) return undefined;
    let active = true, epoch = 0, binding = '', initialized = false;
    const subscription = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active || !initialized) return;
      if (getLogicalSessionIdentity(session) !== binding) {
        epoch += 1;
        setState({ key, status: 'error', message: 'Doctor session changed. Reopen this visit.' });
      }
    }).data.subscription;
    const load = async () => {
      const request = epoch;
      try {
        const { data, error } = await boundedInitialRequest(supabase.auth.getSession());
        if (error) throw error;
        if (!active || request !== epoch) return;
        binding = getLogicalSessionIdentity(data?.session); initialized = true;
        const snapshot = await loadDoctorEncounterSnapshot(supabase, { enabled, env: import.meta.env, row: priorInitial ? null : row, patientId,
          authorizingAppointment, appointments: authorities, binding, isCurrent: () => active && epoch === request });
        if (active && request === epoch) setState({ key, status: snapshot.legacy ? 'legacy' : 'ready', snapshot });
      } catch {
        if (active && request === epoch) setState({ key, status: 'error', message: 'Encounter-time history is unavailable. No current history has been substituted. Reload the visit if it changed, or retry.' });
      }
    };
    void load();
    return () => { active = false; epoch += 1; subscription.unsubscribe(); };
  }, [authorities, authorizingAppointment, enabled, key, legacy, patientId, priorInitial, retry, row]);

  const current = state?.key === key ? state : null;
  const heading = priorInitial ? 'Prior Initial encounter histories — read-only' : 'Encounter-time clinical histories';
  const notice = legacy || current?.status === 'legacy'
    ? 'Encounter-time histories were not recorded for this legacy visit. Patient-level Prenatal History is separate and is not a verified snapshot of this encounter.'
    : !enabled ? 'Encounter-time history verification is not activated. No current history has been substituted for this visit.'
      : current?.status === 'error' ? current.message : current?.status !== 'ready' ? 'Loading encounter-time histories...' : '';
  if (notice) return <section className="doctor-encounter-history mr-medical-section" aria-label={heading}>
    <h4>{heading}</h4><p role={current?.status === 'error' ? 'alert' : 'status'}>{notice}</p>
    {enabled && current?.status === 'error' ? <button type="button" className="mr-toolbar-button" onClick={() => setRetry(value => value + 1)}>Retry history</button> : null}
  </section>;
  const { as_of: asOf, staff_intake: intake } = current.snapshot;
  const obstetric = asOf.obstetric, medical = asOf.medical;
  return <section className="doctor-encounter-history mr-medical-section" aria-label={heading}>
    <h4>{heading}</h4><p>Verified values saved with this encounter. Current patient histories may differ.</p>
    <div className="doctor-encounter-history-grid">
      <section><h4>Reproductive &amp; Obstetric History</h4>
        {!obstetric ? <p>No obstetric history was recorded or resolved for this encounter.</p> : <>
          <dl>{reproductive.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{visible(obstetric[field])}</dd></div>)}</dl>
          <h4>Previous Pregnancy Records</h4><SavedRows value={obstetric.pregnancy_records} />
        </>}
      </section>
      <section><h4>Medical &amp; Family History</h4>
        <dl><div><dt>Blood Type at Encounter</dt><dd>{visible(asOf.patient.blood_type)}</dd></div></dl>
        {!medical ? <p>No medical history was recorded or resolved for this encounter.</p> : <>
          <h4>Allergies</h4><SavedRows value={medical.allergy_records?.length ? medical.allergy_records : medical.allergies} />
          <h4>Medical Conditions</h4><SavedRows value={medical.medical_conditions} /><p>{visible(medical.other_medical_condition)}</p>
          <h4>Family History (Maternal / Paternal / Unassigned)</h4><SavedRows value={medical.family_history} /><p>{visible(medical.other_family_history)}</p>
        </>}
      </section>
    </div>
    <details><summary>Staff pre-consultation source</summary>
      <dl><div><dt>Staff ID</dt><dd>{intake.staff_id}</dd></div><div><dt>Completed at</dt><dd>{intake.captured_at}</dd></div>
        <div><dt>Intake Revision</dt><dd>{intake.id}</dd></div></dl>
      <SavedRows value={Object.entries(intake.payload.intake_data || {}).map(([field, value]) => ({ field, value }))} />
    </details>
  </section>;
}
