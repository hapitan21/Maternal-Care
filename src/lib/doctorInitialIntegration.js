import { getLogicalSessionIdentity } from './roleInactivity.js';
import { assertInitialContext, buildInitialHistoryRequest, cloneClinical } from './doctorInitialHistoryDraft.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
// Pinned browser routing guard. This does not replace server RLS/admission.
// A staging flag alone must never authorize a write against another project.
const STAGING_ORIGIN = 'https://yvwxycpftndkwkcanfnq.supabase.co';
function exactStagingOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === STAGING_ORIGIN && !url.username && !url.password &&
      url.pathname.replace(/\/+$/, '') === '' && !url.search && !url.hash;
  } catch { return false; }
}
export const initialIntegrationEnabled = (env = {}, client = {}) =>
  env.MODE === 'staging' && env.VITE_DOCTOR_INITIAL_INTEGRATION === 'true' &&
  exactStagingOrigin(env.VITE_SUPABASE_URL) && exactStagingOrigin(client.supabaseUrl);
export async function boundedInitialRequest(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Error('Request timed out; a submitted save may still have completed. Retry the identical operation.')), 25000);
  })]); } finally { clearTimeout(timer); }
}
export function assertTrustedInitialIntake(context, ids) {
  if (context?.authoritative === false) throw Error('Read-only history choices are not a versioned save context.');
  assertInitialContext(context, ids);
  const intake = context.staff_intake, payload = intake?.payload;
  if (!uuid.test(intake?.id || '') || !uuid.test(intake?.staff_id || '') || !uuid.test(intake?.intake_id || '') ||
      intake.patient_id !== ids.patientId || intake.appointment_id !== ids.appointmentId || intake.doctor_id !== ids.doctorId || intake.visit_type !== 'initial' ||
      payload?.id !== intake.intake_id || payload.patient_id !== ids.patientId || payload.appointment_id !== ids.appointmentId ||
      payload.staff_id !== intake.staff_id || payload.visit_type !== 'initial' || payload.status !== 'staff_completed' ||
      !intake.captured_at || intake.captured_at !== payload.staff_completed_at ||
      !uuid.test(intake.appointment_state?.generation || '') || !/^(0|[1-9]\d*)$/.test(String(intake.appointment_state?.revision ?? '')) ||
      !['id', 'patient_id', 'doctor_id', 'status', 'start_time', 'end_time'].every(key => same(intake.appointment_state[key], context.state.appointment[key]))) throw Error('Exact trusted Staff intake revision is missing or contradictory. Saving is unavailable.');
  return intake;
}
export function prepareIntegratedInitial(context, draft, form, ids, today) {
  const intake = assertTrustedInitialIntake(context, ids);
  for (const kind of ['obstetric', 'medical']) {
    if (draft[kind].action === 'select' && !same(draft[kind].base, context.state[kind].find(row => row.id === draft[kind].id))) {
      throw Error('A selected history changed. Reselect that history and review your retained draft before saving.');
    }
  }
  return { ...buildInitialHistoryRequest(context, draft, form, ids, today), staff_intake: intake.id };
}
export function acceptIntegratedInitialReadback(result, snapshot, ids, revisionId) {
  const record = snapshot?.record, intake = snapshot?.staff_intake;
  if (!uuid.test(result?.record_id || '') || record?.id !== result.record_id || !same(record, result.committed_record) ||
      record.patient_id !== ids.patientId || record.schedule_id !== ids.appointmentId || record.doctor_id !== ids.doctorId ||
      record.form_data?.visitFormType !== 'initial' || record.form_data?.recordStatus !== 'completed' ||
      intake?.id !== revisionId || intake.patient_id !== ids.patientId || intake.appointment_id !== ids.appointmentId || intake.doctor_id !== ids.doctorId ||
      record.form_data.clinicalHistory?.staff_intake_revision !== revisionId || !same(record.form_data.staffIntake, intake)) {
    throw Error('Required immutable encounter and Staff intake readback differs. Save outcome remains unconfirmed.');
  }
  return record;
}
export function createInitialIntegrationTransport(client, enabled, binding, isCurrent, env = {}) {
  const assertSession = async () => {
    // Check runtime target before even reading auth state. Passing `true` to
    // enabled (including the uncertain-save retry path) cannot bypass this.
    if (!enabled || !initialIntegrationEnabled(env, client)) {
      throw Error('Initial Visit persistence requires explicit activation and the pinned isolated staging Supabase project.');
    }
    const { data, error } = await boundedInitialRequest(client.auth.getSession());
    if (error) throw error;
    if (!binding || !isCurrent() || getLogicalSessionIdentity(data?.session) !== binding) throw Error('Doctor session changed. Reopen this appointment.');
  };
  const rpc = async (name, args) => {
    await assertSession(); const { data, error } = await boundedInitialRequest(client.rpc(name, args)); await assertSession();
    if (error) throw error; return data;
  };
  return {
    context: appointmentId => rpc('get_doctor_initial_intake_context_v1', { p_appointment_id: appointmentId }),
    async save(operationId, request, ids) {
      const result = await rpc('complete_doctor_initial_integrated_v1', { p_appointment_id: ids.appointmentId, p_operation_id: operationId, p_request: request });
      const snapshot = await rpc('get_doctor_intake_encounter_snapshot_v1', { p_authorizing_appointment: ids.appointmentId, p_record_id: result?.record_id });
      return { record: acceptIntegratedInitialReadback(result, snapshot, ids, request.staff_intake), snapshot };
    },
  };
}
// Read-only preparation when the versioned backend is disabled. No guessed
// revisions/current pregnancy, no latest-row selection and no write capability.
export async function loadInitialHistoryChoices(client, table, columns, patientId, isCurrent) {
  const rows = new Map(); let cursor = '';
  for (let page = 0; page < 100 && isCurrent(); page++) {
    let query = client.from(table).select(columns).eq('patient_id', patientId).order('id', { ascending: true }).limit(250);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await boundedInitialRequest(query);
    if (!isCurrent()) throw Error('History load superseded.');
    if (error) throw error;
    if (!Array.isArray(data)) throw Error('Clinical history choices are unavailable.');
    if (!data.length) return [...rows.values()];
    for (const row of data) {
      if (!uuid.test(row.id || '') || row.patient_id !== patientId || (cursor && row.id <= cursor)) throw Error('History choices have contradictory patient linkage or ordering.');
      rows.set(row.id, row);
    }
    cursor = data.at(-1).id;
  }
  throw Error('Complete clinical history choices could not be loaded. Saving remains unavailable.');
}
export const localInitialHistoryContext = (schedule, patient, obstetric, medical) => ({
  contract: 'S4-A7A-v1', authoritative: false,
  state: { appointment: cloneClinical(schedule), patient: cloneClinical(patient), record: null, obstetric, medical, context: null },
});
