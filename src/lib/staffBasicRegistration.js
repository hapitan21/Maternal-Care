// Basic-only registration contract shared by the real Staff wizard and isolated A8B fixture.
export const basicFields = [
  ['name', 'Full Name', true], ['birthdate', 'Date of Birth', true, 'date'],
  ['sexAtBirth', 'Sex at Birth', true], ['civilStatus', 'Civil Status', true],
  ['nationality', 'Nationality'], ['nationalityOther', 'Specify Nationality'],
  ['address', 'Home Address', true], ['contactNumber', 'Patient Contact Number', true],
  ['email', 'Email Address', false, 'email'], ['philHealthMember', 'PhilHealth Membership'],
  ['philHealthPin', 'PhilHealth PIN'], ['occupation', 'Occupation'], ['company', 'Company'],
  ['workAddress', 'Work Address'], ['workContactNumber', 'Work Contact Number'],
  ['husbandPartner', 'Husband / Partner'], ['partnerContactNumber', 'Partner Contact Number'],
  ['emergencyContactPerson', 'Emergency Contact Person', true],
  ['emergencyContactRelationship', 'Emergency Relationship', true],
  ['emergencyContactNumber', 'Emergency Contact Number', true],
];
export const blankBasic = () => Object.fromEntries(basicFields.map(([key]) => [key, key === 'sexAtBirth' ? 'Female' : '']));
export function basicAge(date, today) {
  const [y, m, d] = String(date).split('-').map(Number), [ty, tm, td] = today.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
export function validateBasic(b, today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())) {
  const errors = {};
  for (const [key, label, required] of basicFields) {
    if (required && !String(b[key] ?? '').trim()) errors[key] = `${label} is required.`;
    if (b[key] != null && (typeof b[key] !== 'string' || b[key].length > 2000)) errors[key] = 'Enter text (maximum 2000 characters).';
  }
  for (const key of Object.keys(b)) if (!basicFields.some(([field]) => field === key)) errors[key] = 'Only Basic Information is accepted.';
  const date = new Date(`${b.birthdate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.birthdate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== b.birthdate || b.birthdate > today) errors.birthdate = 'Enter a valid birthdate that is not in the future.';
  for (const key of ['contactNumber', 'emergencyContactNumber', 'partnerContactNumber', 'workContactNumber']) {
    if (b[key] && (typeof b[key] !== 'string' || !/^(09\d{9}|\+639\d{9}|639\d{9}|9\d{9})$/.test(b[key].replace(/[\s()-]/g, '')))) errors[key] = 'Enter a valid Philippine mobile number.';
  }
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errors.email = 'Enter a valid email address.';
  if (b.sexAtBirth !== 'Female') errors.sexAtBirth = 'Sex at Birth must be Female.';
  if (!['Single', 'Married', 'Widowed', 'Separated', 'Divorced', 'Other'].includes(b.civilStatus)) errors.civilStatus = 'Select civil status.';
  if (b.nationality === 'Other' && (typeof b.nationalityOther !== 'string' || !b.nationalityOther.trim())) errors.nationalityOther = 'Specify nationality.';
  if (!['', 'Yes', 'No'].includes(b.philHealthMember ?? '')) errors.philHealthMember = 'Select Yes, No, or Not recorded.';
  return errors;
}
export function buildBasicRegistrationRequest(basic, { doctorId = '', reservationId = '', reviewed = false } = {}) {
  if (reviewed !== true) throw Error('Review Information must be confirmed.');
  if (Object.keys(validateBasic(basic)).length) throw Error('Complete valid Basic Information.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (reservationId && !doctorId) throw Error('Exact selected Doctor required.');
  if (doctorId && !uuid.test(doctorId)) throw Error('Exact Doctor UUID required.');
  if (reservationId && !uuid.test(reservationId)) throw Error('Exact reservation UUID required.');
  return { contract: 'S4-A8B-v1', reviewed: true, basic: structuredClone(basic), doctor_id: doctorId || null, reservation_id: reservationId || null };
}
