import { staffAppointmentWriteMode } from './staffAppointmentIntegration.js';
import { getLogicalSessionIdentity } from './roleInactivity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATABASE_REJECTION = new Set(['22023', '23514', '23505', '42501', '55000', '40001']);
const need = (yes, message) => { if (!yes) throw Error(message); };
const clone = v => JSON.parse(JSON.stringify(v));
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

// No silent staging -> legacy fallback, including a misconfigured build.
// Both the Staff appointment transport and this intake transport must be
// explicitly activated for the pinned isolated staging project.
export function staffIntakeWriteMode(env = {}, client = {}) {
  const appointmentMode = staffAppointmentWriteMode(env, client);
  if (appointmentMode === 'legacy' && env.VITE_STAFF_INTAKE_INTEGRATION !== 'true') return 'legacy';
  return appointmentMode === 'integrated' && env.VITE_STAFF_INTAKE_INTEGRATION === 'true'
    ? 'integrated' : 'blocked';
}

const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Error('Request timed out; the Staff intake outcome may be unknown.')), 25000);
  })]); } finally { clearTimeout(timer); }
};

const appointmentValid = (appointment, ids) =>
  appointment?.id === ids.appointmentId && appointment.patient_id === ids.patientId &&
  appointment.doctor_id === ids.doctorId && ['checked_in', 'checked-in', 'checked in'].includes(appointment.status) &&
  UUID.test(appointment.generation || '') && /^(0|[1-9]\d*)$/.test(String(appointment.revision ?? ''));

export function assertStaffIntakeContext(ctx, ids) {
  need(UUID.test(ids.appointmentId || '') && UUID.test(ids.patientId || '') && UUID.test(ids.doctorId || '') &&
    ctx?.appointment_id === ids.appointmentId && ctx.patient_id === ids.patientId &&
    appointmentValid(ctx.expected_appointment, ids) && ctx.stale === false,
  'Staff intake requires an unchanged, checked-in appointment and exact patient/Doctor linkage. Reload the appointment.');
  const revision = ctx.revision;
  if (revision != null) {
    const row = revision.payload;
    need(UUID.test(revision.id || '') && UUID.test(revision.operation_id || '') &&
      revision.appointment_id === ids.appointmentId && revision.patient_id === ids.patientId &&
      revision.doctor_id === ids.doctorId && revision.visit_type === ids.visitType &&
      row?.id === revision.intake_id && row.appointment_id === ids.appointmentId &&
      row.patient_id === ids.patientId && row.doctor_id === ids.doctorId &&
      row.visit_type === ids.visitType && row.status === 'staff_completed' &&
      same(revision.appointment_state, ctx.expected_appointment),
    'Staff intake provenance is missing, stale or contradictory. Saving is blocked.');
  }
  return ctx;
}

// The deployed clinical cutover accepts unknown GA/EDD/risk, but (when present)
// its GA parser currently permits only 0-40 whole weeks. Preserve all values;
// never round days or replace an unknown value with an invented finding.
export function validateStagingIntakeAge(data) {
  const age = String(data?.gestationalAge ?? '').trim();
  if (age && !/^([0-9]|[12][0-9]|3[0-9]|40)( Weeks?)?$/i.test(age)) {
    throw Error('Staging currently accepts gestational age only as 0–40 whole weeks. Your weeks/days value was preserved. Do not round it; clinical contract review is required.');
  }
}

export function prepareStagingStaffIntake(ctx, ids, form) {
  assertStaffIntakeContext(ctx, ids);
  need(form && typeof form === 'object' && !Array.isArray(form), 'An exact reviewed Staff form is required.');
  validateStagingIntakeAge(form);
  const data = clone(form);
  return { patient_id: ids.patientId, expected_revision: ctx.revision?.id ?? null,
    expected_appointment: clone(ctx.expected_appointment), data };
}

export function confirmStagingStaffIntake(ctx, pending, actorId, receipt = null) {
  const ids = pending.ids, req = pending.request;
  assertStaffIntakeContext(ctx, ids);
  const revision = ctx.revision;
  const row = revision?.payload;
  need(UUID.test(pending.operationId || '') && revision?.operation_id === pending.operationId &&
    revision.staff_id === actorId && UUID.test(revision.intake_id || '') &&
    revision.predecessor === req.expected_revision && same(revision.appointment_state, req.expected_appointment) &&
    row?.staff_id === actorId && row?.status === 'staff_completed' && row?.staff_completed_at &&
    Number.isFinite(Date.parse(row.staff_completed_at)) && same(row.intake_data, req.data),
  'Exact submitted intake and immutable server revision could not be confirmed. The original operation remains pending.');
  if (receipt) need(same(receipt.revision, revision) && typeof receipt.replayed === 'boolean',
    'Staff intake receipt differs from authoritative readback. Original operation remains pending.');
  return row;
}

export function isDefiniteStagingIntakeRejection(error) {
  return error?.serverRejected === true && DATABASE_REJECTION.has(error.code);
}

export function createStagingStaffIntakeTransport(client, env) {
  const session = async () => {
    need(staffIntakeWriteMode(env, client) === 'integrated',
      'Staff staging intake is disabled or the Supabase project is not the approved staging target.');
    const { data, error } = await bounded(client.auth.getSession());
    if (error) throw error;
    const actorId = data?.session?.user?.id;
    const sessionKey = getLogicalSessionIdentity(data?.session);
    need(UUID.test(actorId || '') && sessionKey, 'An active Staff session is required.');
    return { actorId, sessionKey };
  };
  const ensureBinding = async binding => {
    const now = await session();
    need(now.actorId === binding?.actorId && now.sessionKey === binding?.sessionKey,
      'Staff session changed. The original operation cannot be reused in this session.');
  };
  const rpc = async (name, args, binding) => {
    await ensureBinding(binding);
    const { data, error } = await bounded(client.rpc(name, args));
    await ensureBinding(binding);
    if (error) {
      // A received SQL rejection means the transaction was rolled back.
      throw Object.assign(Error(error.message || 'Staff RPC rejected.'), error, { serverRejected: name === 'save_staff_intake_integrated_v1' });
    }
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
  };
  const context = (appointmentId, binding) => rpc('get_staff_intake_revision_context_v1', { p_appointment_id: appointmentId }, binding);
  return {
    session, context,
    async commitOrRecover(pending) {
      const { ids, binding, operationId, request } = pending;
      need(UUID.test(operationId || '') && request?.patient_id === ids.patientId, 'Exact saved Staff operation required.');
      // Always reconcile first; do not blindly replay after a timeout.
      const before = await context(ids.appointmentId, binding);
      assertStaffIntakeContext(before, ids);
      if (before.revision?.operation_id === operationId) {
        return confirmStagingStaffIntake(before, pending, binding.actorId);
      }
      need((before.revision?.id ?? null) === request.expected_revision &&
        same(before.expected_appointment, request.expected_appointment),
        'Staff intake changed since this operation. Do not replay or discard the original draft.');
      const receipt = await rpc('save_staff_intake_integrated_v1', {
        p_appointment_id: ids.appointmentId, p_operation_id: operationId, p_request: request,
      }, binding);
      const after = await context(ids.appointmentId, binding);
      return confirmStagingStaffIntake(after, pending, binding.actorId, receipt);
    },
  };
}
