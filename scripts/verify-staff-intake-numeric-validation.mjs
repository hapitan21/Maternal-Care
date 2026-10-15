// Offline tests of the actual release validators and save callback. No network or SQL.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { parse } from 'espree';
import { getManilaDateKey, getManilaTimeKey } from '../src/lib/appointmentDate.js';

const file = 'src/pages/appointments/StaffPreConsultationForm.jsx';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL(file, root), 'utf8');
const ast = text => parse(text, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
function find(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (['FunctionDeclaration', 'VariableDeclarator'].includes(node.type) && node.id?.name === name) return node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = find(child, name);
      if (result) return result;
    }
  }
  return null;
}
const tree = ast(source);
const declaration = name => {
  const node = find(tree, name);
  assert.ok(node, `Actual source declaration exists: ${name}`);
  return source.slice(...node.range);
};
const validators = ['trimValue', 'parseNumber', 'validateRange', 'validateBloodPressure', 'validateStaffIntake', 'getErrorMessage', 'getAppointmentDisplayId']
  .map(declaration).join('\n');
const context = vm.createContext({});
vm.runInContext(validators, context);
let assertions = 0, scenarios = 0;
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); assertions++; }
async function test(label, run) { await run(); scenarios++; console.log('PASS ' + label); }
const initial = { visitDate: '2026-10-16', visitTime: '09:00', height: '160', weight: '60', temperature: '36.7', respiratoryRate: '18', oxygenSaturation: '98', bloodPressure: '120/80', remarks: 'Synthetic note' };
const followUp = { ...initial, gestationalAge: '24', expectedDeliveryDate: '2027-02-01', pregnancyStatus: 'Low Risk', fetalHeartRate: '140' };
const ranges = {
  initial: [['height', 80, 250], ['weight', 25, 250], ['temperature', 30, 45], ['respiratoryRate', 5, 60], ['oxygenSaturation', 1, 100]],
  follow_up: [['temperature', 30, 45], ['weight', 25, 250], ['fetalHeartRate', 60, 220], ['respiratoryRate', 5, 60], ['oxygenSaturation', 1, 100]],
};
const malformed = ['-60', 'abc60', '-140', 'abc140', '+60', '60kg', '60.5.0', '60.', '.5', '6e1', '0x3c', '6 0', '60,5', 'NaN', 'Infinity', '-Infinity', '9'.repeat(400), NaN, Infinity, -Infinity, true, false, ['60'], { toString: () => '60' }];

for (const [type, base] of [['initial', initial], ['follow_up', followUp]]) {
  await test(type + ': legitimate integer and decimal measurements', () => {
    equal(Object.keys(context.validateStaffIntake(type, base)), [], 'Valid whole assessment');
    for (const [key, min, max] of ranges[type]) {
      for (const value of [String(min), String(max), min, max, String((min + max) / 2), ` ${min}.5 `, `${min}.50`, `0${min}.5`]) {
        equal(Boolean(context.validateStaffIntake(type, { ...base, [key]: value })[key]), false, `${key}: ${value}`);
      }
    }
  });
  await test(type + ': malformed measurements are rejected without partial parsing', () => {
    for (const [key] of ranges[type]) for (const value of malformed) {
      equal(Boolean(context.validateStaffIntake(type, { ...base, [key]: value })[key]), true, `${key}: malformed input`);
    }
  });
  await test(type + ': required fields and existing ranges remain enforced', () => {
    for (const [key, min, max] of ranges[type]) {
      for (const value of ['', '  ', null, undefined]) {
        equal(context.validateStaffIntake(type, { ...base, [key]: value })[key]?.includes('is required.'), true, `${key}: required`);
      }
      for (const value of [0, '0', String(min - 0.1), String(max + 0.1)]) {
        equal(Boolean(context.validateStaffIntake(type, { ...base, [key]: value })[key]), true, `${key}: outside range`);
      }
    }
    for (const key of type === 'initial' ? ['visitDate', 'visitTime', 'bloodPressure'] : ['visitDate', 'visitTime', 'bloodPressure', 'gestationalAge', 'expectedDeliveryDate', 'pregnancyStatus']) {
      equal(Boolean(context.validateStaffIntake(type, { ...base, [key]: '' })[key]), true, `${key}: existing required field`);
    }
  });
}

// Evaluate the actual handler with synthetic closure state and an in-memory RPC stub.
// This tests its validation-to-payload path without duplicating submission logic.
async function save(type, form, nullMutation = false) {
  const calls = [], navigation = [], state = {};
  const appointment = { id: 'synthetic-appointment', maternal_appointment_id: 'SYNTHETIC-001', start_time: '2026-10-16T01:00:00Z' };
  const patient = { id: 'synthetic-patient', patient_id: 'SYNTHETIC-P001', full_name: 'Synthetic Patient' };
  let saved;
  const scope = vm.createContext({ form, appointment, patient, appointmentId: appointment.id, visitType: type, isFollowUp: type === 'follow_up', isReadOnly: false,
    intake: null, saveLockRef: { current: false }, requestIdRef: { current: 1 }, getManilaDateKey, getManilaTimeKey,
    setValidationErrors: value => { state.validation = value; }, setError: value => { state.error = value; },
    setMessage: value => { state.message = value; }, setSaving: value => { state.saving = value; }, setIntake: value => { state.intake = value; },
    navigate: (...args) => navigation.push(args),
    supabase: { async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'save_staff_visit_intake') {
        saved = { id: 'synthetic-intake', patient_id: patient.id, appointment_id: appointment.id, visit_type: type, status: 'staff_completed', intake_data: args.p_intake_data };
        return { data: nullMutation ? null : saved, error: null };
      }
      equal(name, 'get_staff_visit_intake', 'Only existing readback RPC');
      return { data: saved, error: null };
    } },
  });
  vm.runInContext(validators + '\n' + declaration('saveForm') + ';', scope);
  await vm.runInContext('saveForm()', scope);
  return { calls, navigation, state };
}

for (const [type, base] of [['initial', initial], ['follow_up', followUp]]) {
  await test(type + ': malformed measurements never reach the mutation RPC', async () => {
    for (const value of ['-60', 'abc60', '-140', 'abc140']) {
      const field = type === 'initial' ? 'weight' : 'fetalHeartRate';
      const form = { ...base, [field]: value }, before = JSON.stringify(form);
      const result = await save(type, form);
      equal(result.calls.length, 0, 'No mutation or readback for invalid measurement');
      equal(result.navigation.length, 0, 'No navigation');
      equal(Boolean(result.state.validation[field]), true, 'Field error shown');
      equal(result.state.message, '', 'No success');
      equal(JSON.stringify(form), before, 'Entered values preserved');
    }
  });
  await test(type + ': valid payload and confirmed navigation preserve the legacy save workflow', async () => {
    for (const value of ['60', '60.5']) for (const nullMutation of [false, true]) {
      const form = { ...base, weight: value }, before = JSON.stringify(form);
      const { calls, navigation, state } = await save(type, form, nullMutation);
      equal(calls.length, nullMutation ? 2 : 1, 'Readback only when mutation response is inconclusive');
      equal(calls[0].name, 'save_staff_visit_intake', 'Original save RPC');
      equal(calls[0].args.p_visit_form_type, type, 'Legacy visit type');
      equal(calls[0].args.p_appointment_id, 'synthetic-appointment', 'Exact appointment');
      for (const [key, entered] of Object.entries(form)) equal(calls[0].args.p_intake_data[key], entered, `Validated payload: ${key}`);
      equal(navigation.length, 1, 'One navigation after confirmation');
      equal(navigation[0][0], '/staff/appointments', 'Original destination');
      equal(state.intake.status, 'staff_completed', 'Confirmed saved row');
      equal(state.saving, false, 'Save lock UI released');
      equal(JSON.stringify(form), before, 'Form not rewritten');
    }
  });
}

await test('Required-field, range, save and UI functions are unchanged from the release', () => {
  const before = execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, encoding: 'utf8' });
  const beforeTree = ast(before);
  for (const name of ['validateStaffIntake', 'validateBloodPressure', 'saveForm', 'loadForm', 'TextField', 'RiskSelector', 'DateField']) {
    const node = find(beforeTree, name);
    equal(declaration(name).replace(/\r\n/g, '\n'), before.slice(...node.range).replace(/\r\n/g, '\n'), name);
  }
});
console.log(`PASS: ${scenarios} scenarios / ${assertions} assertions. Synthetic validators and actual save handler only; no browser or Supabase calls.`);
