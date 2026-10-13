import { getLogicalSessionIdentity } from './roleInactivity.js';

// Both settings must be explicit. No legacy RPC or synthetic transport fallback.
export function basicRegistrationEnabled(env) {
  return env.MODE === 'staging' && env.VITE_STAFF_BASIC_REGISTRATION === 'true';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function acceptBasicRegistrationReadback(value, request, expectedId, finished = false) {
  const record = Array.isArray(value) ? value[0] : value;
  if (!record || !uuid.test(record.id || '') || !record.patientId || !record.controlNumber ||
      (expectedId && record.id !== expectedId) || !record.basic ||
      record.doctorId !== request.doctor_id || record.reservationId !== request.reservation_id ||
      !['awaiting_patient_access_confirmation', 'completed'].includes(record.registrationStatus) ||
      (finished && record.registrationStatus !== 'completed') ||
      (finished && request.reservation_id && !uuid.test(record.scheduleId || ''))) {
    throw Error('The server did not confirm the exact registration and access details. Retry saved readback.');
  }
  // The server normalizes blanks, whitespace, and the optional nationality/PIN.
  for (const [key, value] of Object.entries(request.basic)) {
    if (key === 'nationalityOther') continue;
    const expected = key === 'nationality' && value === 'Other' ? request.basic.nationalityOther :
      key === 'philHealthPin' && request.basic.philHealthMember !== 'Yes' ? '' : value;
    if (String(record.basic[key] ?? '').trim() !== String(expected ?? '').trim()) {
      throw Error('Saved Basic Information differs from the reviewed information. Registration outcome needs review.');
    }
  }
  return record;
}
export function createBasicRegistrationTransport(client, enabled, binding, isCurrent) {
  const bounded = async promise => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Request timed out; its server outcome is unknown')), 25000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const assertSession = async () => {
    if (!enabled) throw Error('Basic-only registration is awaiting approved staging backend activation.');
    if (!binding || !isCurrent()) throw Error('Staff session changed. Reopen registration.');
    const { data, error } = await bounded(client.auth.getSession());
    if (error) throw error;
    if (!isCurrent() || getLogicalSessionIdentity(data?.session) !== binding) throw Error('Staff session changed. Reopen registration.');
  };
  const rpc = async (name, args) => {
    await assertSession();
    const { data, error } = await bounded(client.rpc(name, args));
    await assertSession();
    if (error) throw error;
    return data;
  };
  return {
    async save(operation, request) {
      await rpc('save_staff_basic_integrated_v1', { p_operation_id: operation, p_request: request });
      return this.read(operation, request);
    },
    async read(operation, request, expectedId, finished = false) {
      const data = await rpc('get_staff_basic_registration_preview_v1', { p_operation_id: operation });
      return acceptBasicRegistrationReadback(data, request, expectedId, finished);
    },
    async finish(operation, request, expectedId) {
      await rpc('finish_staff_basic_integrated_v1', { p_operation_id: operation, p_confirmed: true });
      return this.read(operation, request, expectedId, true);
    },
  };
}
