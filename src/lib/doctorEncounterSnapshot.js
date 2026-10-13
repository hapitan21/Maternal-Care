import { boundedInitialRequest, initialIntegrationEnabled } from './doctorInitialIntegration.js';
import { getLogicalSessionIdentity } from './roleInactivity.js';

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
export const encounterSnapshotsEnabled = initialIntegrationEnabled;
export const hasEncounterManifest = row => row?.form_data?.clinicalHistory != null;

// No latest-row guess: a sole patient-level row is not an encounter-time snapshot.
export async function loadUnambiguousPatientHistory(client, table, patientId) {
  if (!['patient_obstetric_history', 'patient_medical_history'].includes(table) || !uuid(patientId)) throw Error('Invalid history lookup.');
  const { data, error } = await boundedInitialRequest(client.from(table).select('*').eq('patient_id', patientId).limit(2));
  if (error) return { data: null, error, ambiguous: false };
  if (!Array.isArray(data) || data.some(row => !uuid(row.id) || row.patient_id !== patientId)) throw Error('Patient history linkage differs.');
  return { data: data.length === 1 ? data[0] : null, error: null, ambiguous: data.length > 1 };
}

// Strict projection of the reviewed A7A/A8C reader; never join live history rows.
export function acceptDoctorEncounterSnapshot(snapshot, row, patientId) {
  const record = snapshot?.record, manifest = snapshot?.manifest, asOf = snapshot?.as_of;
  if (!uuid(patientId) || !uuid(row?.id) || !uuid(row?.schedule_id) || row.patient_id !== patientId ||
      snapshot?.contract !== 'S4-A7A-v1' || !uuid(snapshot?.encounter_version) || !same(record, row) ||
      !['initial', 'follow_up'].includes(record?.form_data?.visitFormType) || record.form_data.recordStatus !== 'completed' ||
      record.form_data.isDraft !== false || record.form_data.deleted !== false || !uuid(record.doctor_id) ||
      !same(manifest, record.form_data.clinicalHistory) || manifest?.schema !== 'S4-A7A-v1' || !asOf ||
      !uuid(manifest.patient_version) || !uuid(manifest.context_version) || asOf.patient?.id !== patientId || asOf.context?.patient_id !== patientId) {
    throw Error('The immutable encounter snapshot does not match this visit.');
  }
  for (const kind of ['obstetric', 'medical', 'pregnancy']) {
    const id = manifest[kind + '_id'], version = manifest[kind + '_version'], value = asOf[kind];
    if (id == null && version == null && value === null) continue;
    if (!uuid(id) || !uuid(version) || value?.id !== id || value.patient_id !== patientId) throw Error('Encounter history linkage differs.');
  }
  const intake = snapshot.staff_intake, payload = intake?.payload;
  if (manifest.intake_contract !== 'S4-A8C-v1' || !uuid(manifest.staff_intake_revision) || intake?.id !== manifest.staff_intake_revision ||
      !uuid(intake.staff_id) || !uuid(intake.intake_id) || intake.patient_id !== patientId || intake.appointment_id !== record.schedule_id ||
      intake.doctor_id !== record.doctor_id || intake.visit_type !== record.form_data.visitFormType ||
      !same(intake, record.form_data.staffIntake) || payload?.id !== intake.intake_id || payload.staff_id !== intake.staff_id ||
      payload.patient_id !== patientId || payload.appointment_id !== record.schedule_id || payload.visit_type !== intake.visit_type ||
      payload.status !== 'staff_completed' || !intake.captured_at || payload.staff_completed_at !== intake.captured_at) {
    throw Error('Encounter Staff intake provenance differs.');
  }
  return snapshot;
}

export async function loadDoctorEncounterSnapshot(client, { enabled, env = {}, row, patientId, authorizingAppointment, appointments, binding, isCurrent }) {
  // The caller's `enabled` boolean is never authority on its own. Resolve the
  // pinned project from the live client again before every protected request.
  const assertTarget = () => {
    if (!enabled || !encounterSnapshotsEnabled(env, client)) {
      throw Error('Encounter snapshots require explicit activation and the pinned isolated staging Supabase project.');
    }
  };
  assertTarget();
  if (!uuid(authorizingAppointment) || !uuid(patientId) || (row && row.patient_id !== patientId)) throw Error('Invalid encounter authority.');
  let actorId;
  const current = async () => {
    assertTarget();
    const { data, error } = await boundedInitialRequest(client.auth.getSession());
    assertTarget();
    if (error) throw error;
    if (!binding || !isCurrent() || getLogicalSessionIdentity(data?.session) !== binding) throw Error('Doctor session changed.');
    actorId = data.session.user.id;
  };
  await current();
  if (!row) {
    // Lifetime Initial uniqueness: zero/multiple matching records remain unresolved.
    const { data, error } = await boundedInitialRequest(client.from('medical_records').select('*')
      .eq('patient_id', patientId).eq('type', 'Initial Visit').limit(2));
    await current();
    if (error) throw error;
    if (!Array.isArray(data) || data.some(item => item.patient_id !== patientId)) throw Error('Prior Initial patient linkage differs.');
    if (data.length !== 1) throw Error('A single authoritative prior Initial encounter is required; history remains unresolved.');
    row = data[0];
  }
  if (!hasEncounterManifest(row)) return { legacy: true };
  if (!uuid(row.id) || !uuid(row.schedule_id) || row.patient_id !== patientId) throw Error('Invalid encounter linkage.');
  if (Array.isArray(appointments) && row.doctor_id !== actorId) {
    // A current assignee may read a prior author's encounter using another
    // eligible appointment for this same patient. This selects read authority,
    // never a history/current-pregnancy row; the RPC still enforces authorization.
    const eligible = appointments.filter(item => uuid(item.id) && item.patient_id === patientId && item.doctor_id === actorId &&
      ['checked_in', 'completed'].includes(String(item.status || '').toLowerCase().replace(/[- ]/g, '_')));
    authorizingAppointment = eligible.find(item => item.id === row.schedule_id)?.id ||
      eligible.sort((a, b) => a.id.localeCompare(b.id))[0]?.id || authorizingAppointment;
  }
  assertTarget();
  const { data, error } = await boundedInitialRequest(client.rpc('get_doctor_intake_encounter_snapshot_v1', {
    p_authorizing_appointment: authorizingAppointment, p_record_id: row.id,
  }));
  await current();
  if (error) throw error;
  // The Medical Records query intentionally projects columns; the reader returns
  // the complete row. Compare every loaded column and then validate full readback.
  if (!data?.record || Object.keys(row).some(key => !same(row[key], data.record[key]))) throw Error('Encounter changed; reload this visit.');
  return acceptDoctorEncounterSnapshot(data, data.record, patientId);
}
