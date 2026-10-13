// Disconnected staging-only Follow-Up transport. Production keeps its legacy
// read/write flow. Client-side gates are defense in depth, not server admission.
import { getLogicalSessionIdentity } from './roleInactivity.js';
import { cloneClinical, validateInitialEncounter } from './doctorInitialHistoryDraft.js';
import { boundedInitialRequest } from './doctorInitialIntegration.js';

const STAGING_ORIGIN = 'https://yvwxycpftndkwkcanfnq.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const need = (condition, message) => { if (!condition) throw Error(message); };
function exactOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === STAGING_ORIGIN && url.pathname.replace(/\/+$/, '') === '' && !url.search && !url.hash;
  } catch { return false; }
}
export function doctorFollowUpWriteMode(env = {}, client = {}) {
  const requested = env.MODE === 'staging' || env.VITE_DOCTOR_FOLLOWUP_INTEGRATION === 'true' ||
    exactOrigin(env.VITE_SUPABASE_URL) || exactOrigin(client.supabaseUrl);
  if (!requested) return 'legacy';
  return env.MODE === 'staging' && env.VITE_DOCTOR_FOLLOWUP_INTEGRATION === 'true' &&
    env.VITE_DOCTOR_INITIAL_INTEGRATION === 'true' && exactOrigin(env.VITE_SUPABASE_URL) &&
    exactOrigin(client.supabaseUrl) ? 'integrated' : 'blocked';
}

// Never select a latest General record or blindly trust a 30-row timeline.
// Multiple or missing Initials remain unresolved pending an explicit selector.
export function requireUniqueInitial(rows, patientId) {
  need(Array.isArray(rows) && rows.length === 1, 'A single authoritative prior Initial Visit is required. Resolve missing or multiple Initials before Follow-Up.');
  const row = rows[0];
  need(UUID.test(row?.id || '') && UUID.test(row?.schedule_id || '') && row.patient_id === patientId &&
    row.type === 'Initial Visit' && row.form_data?.visitFormType === 'initial' &&
    row.form_data?.recordStatus === 'completed', 'The prior Initial encounter must be completed and linked to this patient.');
  return row;
}

export function assertTrustedFollowUpContext(ctx, ids) {
  const state = ctx?.state, source = ctx?.staff_intake, payload = source?.payload;
  const initial = ctx?.initial_snapshot?.record;
  need(ctx?.contract === 'S4-A8A-v1' && UUID.test(ids?.appointmentId || '') &&
    UUID.test(ids?.patientId || '') && UUID.test(ids?.doctorId || '') && UUID.test(ids?.initialRecordId || '') &&
    ctx.initial_record_id === ids.initialRecordId && initial?.id === ids.initialRecordId &&
    initial.patient_id === ids.patientId && initial.type === 'Initial Visit' &&
    initial.form_data?.visitFormType === 'initial' && initial.form_data?.recordStatus === 'completed' &&
    UUID.test(initial.schedule_id || '') && initial.schedule_id !== ids.appointmentId &&
    state?.patient?.id === ids.patientId && state.appointment?.id === ids.appointmentId &&
    state.appointment.patient_id === ids.patientId && state.appointment.doctor_id === ids.doctorId &&
    state.record == null && ['checked_in', 'checked-in', 'checked in'].includes(state.appointment.status) &&
    ctx.history && typeof ctx.history === 'object',
  'The exact checked-in Follow-Up and immutable Initial anchor are unavailable.');
  need(UUID.test(source?.id || '') && UUID.test(source?.staff_id || '') && UUID.test(source?.intake_id || '') &&
    source.patient_id === ids.patientId && source.appointment_id === ids.appointmentId &&
    source.doctor_id === ids.doctorId && source.visit_type === 'follow_up' &&
    payload?.id === source.intake_id && payload.patient_id === ids.patientId &&
    payload.appointment_id === ids.appointmentId && payload.doctor_id === ids.doctorId &&
    payload.staff_id === source.staff_id && payload.visit_type === 'follow_up' &&
    payload.status === 'staff_completed' && payload.staff_completed_at === source.captured_at &&
    UUID.test(source.appointment_state?.generation || '') &&
    same(Object.fromEntries(['id','patient_id','doctor_id','status','start_time','end_time']
      .map(key => [key, source.appointment_state[key]])),
      Object.fromEntries(['id','patient_id','doctor_id','status','start_time','end_time']
      .map(key => [key, state.appointment[key]]))),
  'An exact trusted, immutable Staff Follow-Up revision is required.');
  return source;
}

export function prepareIntegratedFollowUp(ctx, form, ids, reviewed) {
  const source = assertTrustedFollowUpContext(ctx, ids);
  need(reviewed === true, 'Explicitly review the prior Initial anchor, Staff source and this Follow-Up before saving.');
  const encounter = validateInitialEncounter(form); // Keeps prescriptions; rejects unsupported attachments.
  const canonicalEdd = ctx.state.patient.expected_delivery_date || null;
  if (Object.hasOwn(encounter, 'expectedDeliveryDate')) {
    need((encounter.expectedDeliveryDate || null) === canonicalEdd,
      'Follow-Up cannot update, replace, or clear the canonical Expected Delivery Date.');
  }
  return {
    contract: 'S4-A8A-v1', patient_id: ids.patientId,
    initial_record_id: ids.initialRecordId, reviewed: true,
    expected: cloneClinical(ctx.state), history: cloneClinical(ctx.history),
    staff_intake: source.id, encounter,
  };
}

export function acceptIntegratedFollowUpReadback(result, snapshot, pending) {
  const ids = pending.ids, req = pending.request;
  const record = snapshot?.record, source = snapshot?.staff_intake;
  const manifest = snapshot?.manifest;
  need(UUID.test(result?.record_id || '') && result.record_id === record?.id &&
    same(result?.committed_record, record) && same(result?.snapshot, snapshot) &&
    record.patient_id === ids.patientId && record.schedule_id === ids.appointmentId &&
    record.doctor_id === ids.doctorId && record.type === 'Follow-Up Visit' &&
    record.form_data?.visitFormType === 'follow_up' && record.form_data?.recordStatus === 'completed' &&
    manifest?.initial_record_id === ids.initialRecordId &&
    manifest?.staff_intake_revision === req.staff_intake &&
    source?.id === req.staff_intake && source.patient_id === ids.patientId &&
    source.appointment_id === ids.appointmentId && source.doctor_id === ids.doctorId &&
    source.visit_type === 'follow_up' && same(record.form_data.staffIntake, source) &&
    record.form_data.clinicalHistory?.initial_record_id === ids.initialRecordId &&
    record.form_data.clinicalHistory.staff_intake_revision === req.staff_intake,
  'Authoritative Follow-Up completion/Staff revision readback differs; do not report success.');
  return record;
}

export function createStagingDoctorFollowUpTransport(client, env, binding, isCurrent) {
  const assertSession = async () => {
    need(doctorFollowUpWriteMode(env, client) === 'integrated',
      'Doctor Follow-Up staging writes are not activated for the pinned isolated project.');
    const { data, error } = await boundedInitialRequest(client.auth.getSession());
    if (error) throw error;
    need(binding && isCurrent() && data?.session?.user?.id &&
      getLogicalSessionIdentity(data.session) === binding,
    'Doctor session changed. Close and reopen this exact appointment.');
    return data.session.user.id;
  };
  const rpc = async (name, args) => {
    await assertSession();
    const { data, error } = await boundedInitialRequest(client.rpc(name, args));
    await assertSession();
    if (error) throw error;
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
  };
  return {
    async initial(patientId) {
      await assertSession();
      const { data, error } = await boundedInitialRequest(client.from('medical_records')
        .select('id, patient_id, doctor_id, schedule_id, type, form_data')
        .eq('patient_id', patientId).eq('type', 'Initial Visit').limit(2));
      await assertSession();
      if (error) throw error;
      return requireUniqueInitial(data, patientId);
    },
    context: (appointmentId, initialRecordId) => rpc('get_doctor_follow_up_intake_context_v1', {
      p_appointment_id: appointmentId, p_initial_record_id: initialRecordId,
    }),
    async save(pending) {
      need(UUID.test(pending?.id || '') && pending?.request?.patient_id === pending?.ids?.patientId &&
        pending.request.initial_record_id === pending.ids.initialRecordId &&
        pending.request.staff_intake && pending.request.reviewed === true,
      'An exact reviewed Follow-Up operation and original request are required.');
      // Deliberately keep the same operation and request across an uncertain
      // response. The database reconciles its immutable receipt on replay.
      const result = await rpc('complete_doctor_follow_up_integrated_v1', {
        p_appointment_id: pending.ids.appointmentId, p_operation_id: pending.id,
        p_request: pending.request,
      });
      need(UUID.test(result?.record_id || ''), 'Completion receipt is missing; retry the identical operation.');
      const snapshot = await rpc('get_doctor_intake_encounter_snapshot_v1', {
        p_authorizing_appointment: pending.ids.appointmentId, p_record_id: result.record_id,
      });
      return acceptIntegratedFollowUpReadback(result, snapshot, pending);
    },
  };
}
