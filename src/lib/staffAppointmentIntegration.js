import { getLogicalSessionIdentity } from './roleInactivity.js';

// Browser-side routing guard, not a substitute for server-side RLS/admission.
// This project is intentionally pinned: never target the existing live project.
const STAGING_ORIGIN = 'https://yvwxycpftndkwkcanfnq.supabase.co';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = 'id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status';

function exactStagingOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === STAGING_ORIGIN && url.pathname.replace(/\/+$/, '') === '' && !url.search && !url.hash;
  } catch { return false; }
}

export function staffAppointmentWriteMode(env = {}, client = {}) {
  const requested = env.MODE === 'staging' || env.VITE_STAFF_APPOINTMENT_INTEGRATION === 'true' ||
    exactStagingOrigin(env.VITE_SUPABASE_URL) || exactStagingOrigin(client.supabaseUrl);
  if (!requested) return 'legacy';
  return env.MODE === 'staging' && env.VITE_STAFF_APPOINTMENT_INTEGRATION === 'true' &&
    exactStagingOrigin(env.VITE_SUPABASE_URL) && exactStagingOrigin(client.supabaseUrl)
    ? 'integrated' : 'blocked';
}

const bounded = async promise => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Request timed out. Server outcome is unknown; retry the identical operation.')), 25000);
    })]);
  } finally { clearTimeout(timer); }
};
const requireValue = (condition, message) => { if (!condition) throw Error(message); };
const sameTime = (a, b) => Boolean(a && b && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b));

// Each transport method requires an initiating logical session. The caller owns
// the stable operation ID and exact request until authoritative readback passes.
export function createStagingStaffAppointmentTransport(client, env) {
  const target = () => requireValue(staffAppointmentWriteMode(env, client) === 'integrated',
    'Staff appointment integrated writes are disabled or the Supabase project is not the reviewed staging project.');
  const session = async () => {
    target();
    const { data, error } = await bounded(client.auth.getSession());
    if (error) throw error;
    const actorId = data?.session?.user?.id;
    const sessionKey = getLogicalSessionIdentity(data?.session);
    requireValue(uuid.test(actorId || '') && sessionKey, 'A current Staff login session is required.');
    return { actorId, sessionKey };
  };
  const assertSession = async (binding) => {
    const current = await session();
    requireValue(binding?.actorId === current.actorId && binding?.sessionKey === current.sessionKey,
      'Staff session changed. Stop and reopen the appointment workflow.');
  };
  const rpc = async (name, args, binding) => {
    await assertSession(binding);
    const { data, error } = await bounded(client.rpc(name, args));
    await assertSession(binding);
    if (error) throw error;
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
  };
  const schedule = async (appointmentId, binding) => {
    await assertSession(binding);
    const { data, error } = await bounded(client.from('schedule').select(fields).eq('id', appointmentId).single());
    await assertSession(binding);
    if (error) throw error;
    requireValue(data?.id === appointmentId, 'Exact appointment readback is unavailable.');
    return data;
  };
  const checkState = (ctx, row) => {
    requireValue(ctx?.appointment_id === row.id && ctx?.patient_id === row.patient_id &&
      ctx.expected_appointment?.id === row.id && ctx.expected_appointment.patient_id === row.patient_id &&
      ctx.expected_appointment.doctor_id === row.doctor_id && ctx.expected_appointment.status === row.status &&
      sameTime(ctx.expected_appointment.start_time, row.start_time) &&
      sameTime(ctx.expected_appointment.end_time, row.end_time) &&
      uuid.test(ctx.expected_appointment.generation || '') &&
      /^(0|[1-9]\d*)$/.test(String(ctx.expected_appointment.revision ?? '')),
    'Authoritative appointment revision/readback does not match. Do not claim success.');
  };
  const context = (appointmentId, binding) => rpc('get_staff_intake_revision_context_v1', { p_appointment_id: appointmentId }, binding);
  return {
    session,
    context,
    async create(operationId, request, binding) {
      requireValue(uuid.test(operationId || '') && uuid.test(request?.patient_id || '') && uuid.test(request?.doctor_id || '') &&
        typeof request.title === 'string' && typeof request.description === 'string' &&
        Number.isFinite(Date.parse(request?.start_time)), 'Complete exact appointment creation request required.');
      const receipt = await rpc('create_staff_appointment_integrated_v1', {
        p_operation_id: operationId, p_request: request,
      }, binding);
      requireValue(uuid.test(receipt?.appointment_id || '') && receipt.patient_id === request.patient_id,
        'Exact operation receipt is missing. Retry the identical operation.');
      const row = await schedule(receipt.appointment_id, binding);
      requireValue(row.patient_id === request.patient_id && row.doctor_id === request.doctor_id &&
        row.title === request.title && row.description === request.description &&
        sameTime(row.start_time, request.start_time) && row.status === 'scheduled' &&
        Date.parse(row.end_time) > Date.parse(row.start_time),
        'Saved appointment does not match the reviewed request. Do not claim success.');
      checkState(await context(row.id, binding), row);
      return row;
    },
    async checkIn(appointmentId, operationId, request, binding) {
      requireValue(uuid.test(appointmentId || '') && uuid.test(operationId || '') &&
        uuid.test(request?.patient_id || '') && request?.expected_appointment?.id === appointmentId &&
        request.expected_appointment.patient_id === request.patient_id &&
        ['scheduled', 'pending'].includes(request.expected_appointment.status) &&
        uuid.test(request.expected_appointment.generation || '') &&
        /^(0|[1-9]\d*)$/.test(String(request.expected_appointment.revision ?? '')),
        'Exact scheduled check-in request required.');
      const receipt = await rpc('check_in_staff_integrated_v1', {
        p_appointment_id: appointmentId, p_operation_id: operationId, p_request: request,
      }, binding);
      requireValue(receipt?.appointment_id === appointmentId && receipt.patient_id === request.patient_id,
        'Exact check-in operation receipt is missing. Retry identical operation.');
      const row = await schedule(appointmentId, binding);
      requireValue(row.patient_id === request.patient_id && row.status === 'checked_in',
        'Check-in status was not confirmed.');
      checkState(await context(appointmentId, binding), row);
      return row;
    },
  };
}

// In-memory operation fencing. Unknown outcomes retain the exact payload/UUID
// so a retry cannot create a second appointment or change the check-in target.
export async function runStableStaffOperation(ref, transport, key, buildRequest, execute) {
  const binding = await transport.session();
  let operation = ref.current;
  if (operation) {
    requireValue(operation.key === key && operation.binding.actorId === binding.actorId &&
      operation.binding.sessionKey === binding.sessionKey,
      'An earlier Staff operation is not yet confirmed. Restore the original request or reopen this workflow for reconciliation.');
  } else {
    const request = await buildRequest(binding);
    const operationId = crypto.randomUUID();
    requireValue(uuid.test(operationId) && request && typeof request === 'object',
      'An exact operation identity and request are required.');
    operation = { key, operationId, request, binding };
    ref.current = operation;
  }
  try {
    const result = await execute(operation);
    ref.current = null;
    return result;
  } catch (error) {
    // A definite PostgreSQL rejection rolls back its whole transaction.
    // Unknown network/readback failures keep the exact retry identity.
    if (['22023', '23514', '23505', '42501', '55000'].includes(error?.code)) ref.current = null;
    throw error;
  }
}
