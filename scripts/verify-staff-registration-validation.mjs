// Offline: actual registration module, handlers and rendered JSX. All transports blocked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import vm from 'node:vm';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'espree';
import { transformWithOxc } from 'vite';
import postcss from 'postcss';
import * as dates from '../src/lib/appointmentDate.js';
import * as patientStatus from '../src/lib/patientAccountStatus.js';
import { isValidPhilippineMobileNumber } from '../src/lib/philippinePhone.js';

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const file = 'src/pages/staff/Staff_Patients.jsx';
const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
  return null;
}
const blocked = () => { throw Error('Live transport/action forbidden in registration fixture'); };
const context = vm.createContext({ React, Date, console, window: {}, URLSearchParams });
const imports = tree.body.filter(node => node.type === 'ImportDeclaration');
const available = {
  react: { ...React, default: React }, 'react/jsx-runtime': jsxRuntime,
  '../../lib/appointmentDate': dates,
  '../../lib/patientAccountStatus': patientStatus,
  '../../lib/patientAccessUrl': { buildPatientAccessUrl: ({patientId,controlNumber}) => 'https://example.invalid/patient/access?patientId='+patientId+'&control='+controlNumber },
  'qrcode.react': { QRCodeSVG: props => React.createElement('svg', { role: 'img', 'aria-label': props.title }) },
  '../../lib/philippinePhone': { isValidPhilippineMobileNumber },
  '../../lib/supabaseClient': { supabase: { rpc: blocked, from: blocked, auth: { getUser: blocked } } },
};
const names = [
  ...tree.body.filter(node => node.type === 'FunctionDeclaration').map(node => node.id.name),
  'blankForm', 'steps', 'allergyTypeOptions', 'optionalObstetricCountFields',
  'registrationNameFields', 'registrationNumberFields', 'registrationPhoneFields', 'humanReadableRegistrationFields',
  'civilStatusOptions', 'nationalityOptions', 'bloodTypeOptions',
];
const code = (await transformWithOxc(source + '\nexport {' + names.join(',') + '};', file,
  { jsx: { runtime: 'automatic', development: false } })).code;
const module = new vm.SourceTextModule(code, { context });
await module.link(spec => {
  const entry = imports.find(node => node.source.value === spec);
  const values = available[spec] || Object.fromEntries(entry.specifiers.map(item => [
    item.type === 'ImportDefaultSpecifier' ? 'default' : item.imported.name,
    spec === '@iconify/react' ? () => null : blocked,
  ]));
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
const actual = module.namespace;
const serial = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function equal(value, expected, label) { assert.deepEqual(serial(value), expected, label); checks++; }
function check(value, label) { assert.ok(value, label); checks++; }
function rejects(fn, label) { assert.throws(fn, /Review invalid/, label); checks++; }
const base = {
  ...serial(actual.blankForm), name: 'Maria Dela Cruz', email: 'maria@example.test', birthdate: '1995-01-01', age: '31',
  civilStatus: 'Single', address: 'Synthetic address', philHealthMember: 'No',
  contactNumber: '09171234567', emergencyContactPerson: 'Ana Dela Cruz',
  emergencyContactRelationship: 'Mother', emergencyContactNumber: '09181234567',
  gravida: '2', para: '1',
};
equal(actual.getStepOneValidationErrors(base), {}, 'Valid demographics');
equal(actual.getStepTwoValidationErrors(base), {}, 'Valid obstetric history');

const validNames = ['María Dela Cruz', 'Ñina Muñoz', 'Nin\u0303a Pen\u0303a', "O'Neill", 'D’Arcy', 'Kaʼiulani',
  'Anne-Marie', 'J. P. Santos', 'McDonald', 'Nguyễn Thị Ánh', '李 美', 'عبد الله', 'Santos Jr.'];
const invalidNames = ['Maria2', '123', 'Maria@Cruz', '<Maria>', 'Maria/Cruz', 'Maria_Cruz', 'Maria🙂',
  'Maria\\Cruz', 'Maria\nCruz', 'Maria\tCruz', '---', '...', '´'];
for (const field of serial(actual.registrationNameFields)) {
  for (const name of validNames) equal(Boolean(actual.getStepOneValidationErrors({ ...base, [field]: name })[field]), false, field + ' accepts Unicode/punctuation');
  for (const name of invalidNames) {
    equal(Boolean(actual.getStepOneValidationErrors({ ...base, [field]: name })[field]), true, field + ' rejects invalid symbols/digits');
    rejects(() => actual.createRegistrationDataPayload({ ...base, [field]: name }, null), 'Malformed name blocked in payload');
  }
}
for (const value of ['McDonald', 'MacLeod', 'de la Cruz', 'van der Waals', 'MARY ANN', 'J. P. O’Neill', 'Nguyễn Thị Ánh']) {
  equal(actual.normalizePersonName(value), value, 'Intentional case/particles/initials retained');
}
equal(actual.normalizePersonName('  maria   dela cruz  '), 'Maria dela Cruz', 'Whitespace/lowercase correction');
equal(actual.normalizePersonName('mARÍA-jOSÉ'), 'María-José', 'Obvious inverted case correction');
equal(actual.normalizePersonName('n\u0303ina'), 'N\u0303ina', 'Combining accent retained');

for (const value of ['12abc', 'abc12', '-1', '+1', '1.5', '1.0', '1e2', '1E2', '2,000', '2 3', 'Infinity', 'NaN', '0x10', '2/3', '2147483648']) {
  equal(actual.parseOptionalNumber(value), null, 'No substring/decimal/exponent parsing');
  for (const field of serial(actual.registrationNumberFields)) {
    equal(Boolean(actual.getStepTwoValidationErrors({ ...base, [field]: value })[field]), true, field + ' rejects entire malformed input');
    rejects(() => actual.createRegistrationDataPayload({ ...base, [field]: value }, null), 'Invalid numeric payload rejected');
  }
}
for (const value of ['', ' ', null, undefined]) equal(actual.parseOptionalNumber(value), null, 'Unanswered does not become zero');
for (const [value, expected] of [['0', 0], [0, 0], [' 12 ', 12], ['0002', 2], ['2147483647', 2147483647]]) {
  equal(actual.parseOptionalNumber(value), expected, 'Strict valid integer parsing');
}
const optionalNumbers = ['ageMenarche', 'cycleLength', 'durationMenstruation', ...serial(actual.optionalObstetricCountFields).map(item => item.key)];
for (const field of optionalNumbers) {
  equal(Boolean(actual.getStepTwoValidationErrors({ ...base, [field]: '' })[field]), false, field + ' may be blank');
  equal(actual.createRegistrationDataPayload({ ...base, [field]: '' }, null)[field], '', 'Unanswered payload remains blank');
}
for (const field of ['gravida', 'para', ...serial(actual.optionalObstetricCountFields).map(item => item.key)]) {
  const form = { ...base, gravida: '0', para: '0', [field]: '0' };
  equal(Boolean(actual.getStepTwoValidationErrors(form)[field]), false, field + ' preserves real zero');
  equal(actual.createRegistrationDataPayload(form, null)[field], '0', 'Zero survives preparation');
}
equal(Boolean(actual.getStepTwoValidationErrors({ ...base, gravida: 0, para: 0 }).gravida), false, 'Numeric zero in restored draft accepted');
equal(Boolean(actual.getStepTwoValidationErrors({ ...base, gravida: '1', para: '2' }).para), true, 'Existing Para <= Gravida rule');
for (const [field, good, bad] of [['ageMenarche', [8, 25], [0, 7, 26]], ['cycleLength', [15, 60], [0, 14, 61]], ['durationMenstruation', [1, 15], [0, 16]]]) {
  for (const value of good) equal(Boolean(actual.getStepTwoValidationErrors({ ...base, [field]: String(value) })[field]), false, 'Existing range boundary accepted');
  for (const value of bad) equal(Boolean(actual.getStepTwoValidationErrors({ ...base, [field]: String(value) })[field]), true, 'Existing range boundary rejected');
}
for (const value of ['2000-02-29', '2024-02-29', '1900-02-28', '0001-01-01', '1990-12-31']) equal(actual.isValidRegistrationDate(value), true, 'Real calendar date');
const badDates = ['2026-02-30', '2026-02-29', '1900-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '0000-01-01', '2026-2-01', 'garbage'];
for (const value of badDates) {
  equal(actual.isValidRegistrationDate(value), false, 'Impossible/malformed date rejected');
  equal(actual.calculateAgeFromBirthdate(value), '', 'Invalid DOB cannot calculate misleading age');
  equal(Boolean(actual.getStepOneValidationErrors({ ...base, birthdate: value }).birthdate), true, 'Invalid DOB field error');
  for (const field of ['lmp', 'edd']) equal(Boolean(actual.getStepTwoValidationErrors({ ...base, [field]: value })[field]), true, 'Invalid history date field error');
  const form = { ...base, pregnancyRecords: [{ id: 'synthetic-history', birthdate: value }] };
  equal(Boolean(actual.getStepTwoValidationErrors(form)['pregnancyBirthdate-0']), true, 'History row date field error');
  rejects(() => actual.createRegistrationDataPayload(form, null), 'Invalid pregnancy date blocked in payload');
}
equal(actual.calculateAgeFromBirthdate(dates.getManilaDateKey()), '0', 'Newborn age remains zero');
equal(Boolean(actual.getStepOneValidationErrors({ ...base, birthdate: dates.getManilaDateKey() }).birthdate), false, 'Existing recent-DOB behavior retained');
equal(Boolean(actual.getStepOneValidationErrors({ ...base, birthdate: '2999-01-01' }).birthdate), true, 'Future DOB rejected');
equal(Boolean(actual.getStepTwoValidationErrors({ ...base, lmp: '2999-01-01' }).lmp), true, 'Future LMP rejected');
equal(actual.getStepTwoValidationErrors({ ...base, edd: '1990-01-01', pregnancyRecords: [{ birthdate: '1940-02-29' }] }), {}, 'No new arbitrary historical date restriction');

// Actual input and state handlers: valid edits stay intact; invalid edits are rejected whole.
Object.assign(context, Object.fromEntries(names.map(name => [name, actual[name]])));
Object.assign(context, dates);
context.form = serial(base); context.errors = {};
context.setForm = value => { context.form = typeof value === 'function' ? value(context.form) : value; };
context.setRegistrationErrors = value => { context.errors = typeof value === 'function' ? value(context.errors) : value; };
function install(name) {
  const node = find(tree, n => n.type === 'VariableDeclarator' && n.id?.name === name);
  assert.ok(node, 'Actual handler ' + name);
  vm.runInContext('const ' + source.slice(...node.range) + ';', context);
}
for (const name of ['clearResolvedRegistrationError', 'updateForm', 'normalizeFormField', 'updateBirthdate', 'updateLmp', 'updatePregnancyRecord', 'removePregnancyRecord']) install(name);
for (const value of ['1', '12', '12abc', '-2', '1.2', '1e3', '', '0002']) {
  const previous = context.form.gravida;
  context.entered = value;
  vm.runInContext('updateForm("gravida", entered)', context);
  equal(context.form.gravida, /^\d*$/.test(value) ? value : previous, 'Invalid edits rejected whole without stripping or changing data types');
}
context.form = { ...serial(base), name: 'maria dela cruz' };
vm.runInContext('updateForm("name", "maria dela cruz")', context);
equal(context.form.name, 'maria dela cruz', 'No capitalization while typing');
vm.runInContext('normalizeFormField("name")', context);
equal(context.form.name, 'Maria dela Cruz', 'Actual blur handler normalizes name');
context.form = { ...serial(base), husbandPartner: 'Partner2' };
vm.runInContext('normalizeFormField("husbandPartner")', context);
check(context.errors.husbandPartner, 'Partner blur exposes field error');
vm.runInContext('updateForm("husbandPartner", "Juan Dela Cruz")', context);
check(!context.errors.husbandPartner, 'Corrected partner name clears error');
context.errors = { edd: 'invalid' };
vm.runInContext('updateLmp("2026-01-01")', context);
equal(context.form.edd, dates.addCalendarDaysToDateInput('2026-01-01', 280), 'Existing automatic EDD preserved');
check(!context.errors.edd, 'Correcting LMP clears stale EDD error');
vm.runInContext('updateLmp("2026-02-30")', context);
equal(context.form.edd, '', 'Impossible LMP cannot calculate a false EDD');
context.form = { ...serial(base), pregnancyRecords: [{ id: 'one', birthdate: '2026-02-30' }, { id: 'two', birthdate: '2020-02-29' }] };
context.errors = { 'pregnancyBirthdate-0': 'invalid', name: 'retained' };
vm.runInContext('removePregnancyRecord("one")', context);
check(!context.errors['pregnancyBirthdate-0'] && context.errors.name === 'retained', 'Removing invalid history row preserves unrelated errors');

// Exercise actual input-event handlers with a synthetic DOM node, not a second filter.
function inputFixture(restriction, initial) {
  const state = { accepted: initial, draft: null, commits: [], blurCalls: 0 };
  const editRef = { current: { composing: false, selection: null } };
  const node = { value: initial, selectionStart: initial.length, selectionEnd: initial.length, selectionDirection: 'none',
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  const handlers = () => actual.createRegistrationInputHandlers({ value: state.accepted, restriction, editRef,
    setCompositionValue: value => { state.draft = value; }, onBlur: () => { state.blurCalls++; },
    onChange: value => { state.accepted = value; state.commits.push(value); } });
  const event = extra => ({ currentTarget: node, target: node, nativeEvent: {}, ...extra });
  function insert(text, method = 'type') {
    let prevented = false;
    const action = event({ data: text, clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
    const current = handlers();
    if (method === 'paste') current.onPaste(action); else current.onBeforeInput(action);
    if (!prevented) {
      const offset = node.selectionStart;
      node.value = node.value.slice(0, offset) + text + node.value.slice(node.selectionEnd);
      node.setSelectionRange(offset + text.length, offset + text.length);
      current.onChange(event());
    }
    return prevented;
  }
  function change(value, nativeEvent = {}) { node.value = value; handlers().onChange(event({ nativeEvent })); }
  return { state, node, handlers, event, insert, change };
}
for (const [kind, initial, bad] of [
  ['name', 'Maria', '32312312'], ['name', 'Maria', '@🙂'], ['phone', '0917', 'dasdas'],
  ['phone', '0917', '+63'], ['phone', '0917', '/#'], ['integer', '12', '1e3'],
  ['integer', '12', '-2'], ['integer', '12', '1.5'], ['integer', '12', '+2'],
  ['integer', '12', ' 2 '], ['pin', '07', 'abc123'],
]) {
  for (const method of ['type', 'paste']) {
    const field = inputFixture(kind, initial);
    equal(field.insert(bad, method), true, 'Invalid ' + method + ' prevented before insertion');
    equal(field.node.value, initial, 'Invalid characters never enter normal typing/paste field value');
    equal(field.state.accepted, initial, 'Controlled state unchanged');
    equal(field.state.commits.length, 0, 'No filtered or clinically reinterpreted value committed');
  }
  const autofill = inputFixture(kind, initial);
  autofill.change(initial + bad);
  equal(autofill.node.value, initial, 'Autofill/input-event fallback restores DOM value immediately');
  equal(autofill.state.accepted, initial, 'Autofill/input-event fallback preserves controlled state');
}
for (const name of validNames) {
  const field = inputFixture('name', '');
  equal(field.insert(name, 'paste'), false, 'Supported Unicode name paste accepted intact');
  equal(field.state.accepted, name, 'Name not capitalized or transliterated during editing');
}
for (const value of ['', '0', '09', '+', '+6', '+63', '+639', '09171234567', '+63 (917) 123-4567', '639171234567', '(02) 8123-4567']) {
  const field = inputFixture('phone', '');
  equal(field.insert(value, 'paste'), false, 'Existing phone characters and incomplete editing values supported');
  equal(field.state.accepted, value, 'Phone text/leading zeros preserved');
}
for (const value of ['07', '071234567891', '07-123456789-1', ' 07-123456789-1 ']) {
  const field = inputFixture('pin', ''); field.insert(value, 'paste');
  equal(field.state.accepted, value, 'Existing PIN digits/formatting unchanged');
}
const replacement = inputFixture('name', 'Maria Santos');
replacement.node.setSelectionRange(0, 5); replacement.handlers().onSelect(replacement.event());
replacement.insert('Ana2', 'paste');
equal([replacement.node.value, replacement.node.selectionStart, replacement.node.selectionEnd], ['Maria Santos', 0, 5], 'Rejected replacement preserves selection');
replacement.insert('Ana', 'paste');
equal(replacement.state.accepted, 'Ana Santos', 'Valid replacement edits only selection');
replacement.node.setSelectionRange(3, 3); replacement.handlers().onBeforeInput(replacement.event({ data: null, preventDefault: blocked }));
replacement.change('An2a Santos');
equal([replacement.node.value, replacement.node.selectionStart, replacement.node.selectionEnd], ['Ana Santos', 3, 3], 'Fallback rejection restores prior caret');
replacement.change('Ana'); equal(replacement.state.accepted, 'Ana', 'Backspace/Delete-style change works');
replacement.node.setSelectionRange(0, 3); replacement.handlers().onCut(replacement.event());
replacement.change(''); equal(replacement.state.accepted, '', 'Cut/clear accepts optional empty value');
replacement.change('Ana'); equal(replacement.state.accepted, 'Ana', 'Undo-style valid restoration works');
replacement.handlers().onBlur(replacement.event()); equal(replacement.state.blurCalls, 1, 'Existing normal blur behavior retained');
check(!('onKeyDown' in replacement.handlers()), 'Accessible keyboard shortcuts are not intercepted');
const ime = inputFixture('name', '');
ime.handlers().onCompositionStart(ime.event()); ime.change('に', { isComposing: true });
equal(ime.state.accepted, '', 'IME preedit does not enter registration state');
equal(ime.state.draft, 'に', 'IME preedit remains available to native composition');
ime.change('日本', { isComposing: true }); ime.handlers().onCompositionEnd(ime.event());
equal([ime.state.accepted, ime.state.draft], ['日本', null], 'Unicode composition commits intact');
for (const end of ['onCompositionEnd', 'onBlur']) {
  const field = inputFixture('integer', '12');
  field.handlers().onCompositionStart(field.event()); field.change('１２', { isComposing: true });
  field.handlers()[end](field.event());
  equal([field.node.value, field.state.accepted, field.state.draft], ['12', '12', null], 'Invalid IME result rejected whole on ' + end);
  equal(field.state.commits.length, 0, 'IME never converts full-width text to clinical digits');
}
const unrestricted = inputFixture('', '');
unrestricted.change('Unit 2, #10 / Building @ A');
equal(unrestricted.state.accepted, 'Unit 2, #10 / Building @ A', 'Address/email/occupation inputs keep their existing character rules');
for (const field of [...serial(actual.registrationNameFields), ...serial(actual.registrationNumberFields), ...serial(actual.registrationPhoneFields), 'philHealthPin']) {
  const previous = context.form[field]; context.entered = 'invalid123@'; context.field = field;
  vm.runInContext('updateForm(field, entered)', context);
  equal(context.form[field], previous, 'Direct controlled-handler input also rejects unsupported characters: ' + field);
}
for (const field of serial(actual.registrationPhoneFields)) {
  equal(Boolean(actual.getStepOneValidationErrors({ ...base, [field]: 'dasdas' })[field]), true, 'Malformed saved/programmatic phone value fails submit validation');
  rejects(() => actual.createRegistrationDataPayload({ ...base, [field]: 'dasdas' }, null), 'Malformed phone cannot enter prepared payload');
}
equal(Boolean(actual.getStepOneValidationErrors({ ...base, contactNumber: '09' }).contactNumber), true, 'Partial phone editing still requires full final format');
for (const [fields, kind, keyboard] of [
  [serial(actual.registrationNameFields), 'name', null],
  [serial(actual.registrationPhoneFields), 'phone', 'tel'],
  [['ageMenarche', 'cycleLength', 'durationMenstruation', 'gravida', 'para'], 'integer', 'numeric'],
  [['philHealthPin'], 'pin', 'numeric'],
]) {
  for (const field of fields) {
    const input = find(tree, node => node.type === 'JSXElement' && node.openingElement.name.name === 'InputField' &&
      node.openingElement.attributes.some(item => item.name?.name === 'value' && item.value?.expression?.object?.name === 'form' && item.value.expression.property?.name === field));
    check(input, 'Actual restricted field exists: ' + field);
    const prop = name => input.openingElement.attributes.find(item => item.name?.name === name)?.value;
    equal(prop('inputRestriction')?.value, kind, 'Event guard actually wired to ' + field);
    equal(actual.getRegistrationInputRestriction(field), kind, 'Controlled state guard agrees for ' + field);
    if (keyboard) equal(prop('inputMode')?.value, keyboard, 'Expected mobile keyboard for ' + field);
  }
}
const optionalCountInput = find(tree, node => node.type === 'JSXElement' && node.openingElement.name.name === 'InputField' &&
  node.openingElement.attributes.some(item => item.name?.name === 'value' && item.value?.expression?.object?.name === 'form' &&
    item.value.expression.computed && item.value.expression.property?.name === 'key'));
check(optionalCountInput.openingElement.attributes.some(item => item.name?.name === 'inputRestriction' && item.value?.value === 'integer'), 'All mapped obstetric count inputs use actual event guard');
const inputBody = find(tree, node => node.type === 'FunctionDeclaration' && node.id?.name === 'InputField');
check(Boolean(find(inputBody, node => node.type === 'JSXSpreadAttribute' && node.argument?.name === 'inputHandlers')), 'Input element receives shared event handlers');
check(Boolean(find(inputBody, node => node.type === 'JSXAttribute' && node.name?.name === 'value' && node.value?.expression?.type === 'LogicalExpression' &&
  node.value.expression.operator === '??' && node.value.expression.left?.name === 'compositionValue')), 'Only IME preedit uses separate local display state');

// Execute actual three-step gate and final RPC handler with synthetic transport only.
for (const name of ['validateRegistrationStep', 'generatePatientAccess']) install(name);
context.setStep = value => { context.step = value; }; context.setRegistrationView = value => { context.view = value; };
context.setStatusMessage = () => {}; context.focusRegistrationField = () => {}; context.scrollRegistrationToTop = () => {};
context.isSavingPatient = false; context.registrationRecord = null; context.registrationToken = 'synthetic-registration-token';
context.createRegistrationToken = blocked; context.setRegistrationToken = () => {}; context.setIsSavingPatient = () => {};
const reservation = { reservationId: 'synthetic-reservation', doctorId: 'synthetic-doctor', date: '2026-10-22', time: '09:00', doctorName: 'Synthetic Doctor' };
context.selectedWalkInSlot = reservation; context.findRegistrationConflict = async () => null;
const calls = []; context.supabase = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { id: 'synthetic-patient', patient_id: 'SYNTHETIC-ID', control_number: 'SYNTHETIC-NOT-A-CREDENTIAL' }, error: null }; } };
context.setRegistrationRecord = () => {}; context.setAccessCredentials = () => {}; context.setQrReceiptConfirmed = () => {};
context.window = { sessionStorage: { setItem() {} } }; context.staffRegistrationSessionKey = 'synthetic';
context.isMissingRegistrationWorkflowError = () => false;
for (const form of [{ ...base, name: 'Maria2' }, { ...base, cycleLength: '28days' }, { ...base, edd: '2026-02-30' }]) {
  context.form = serial(form); await vm.runInContext('generatePatientAccess()', context);
  equal(calls.length, 0, 'Invalid form cannot reach registration RPC');
}
context.form = serial(base); await vm.runInContext('generatePatientAccess()', context);
equal(calls.length, 1, 'Valid form uses existing registration RPC once');
equal(calls[0].name, 'save_patient_registration', 'Existing RPC unchanged');
equal(calls[0].args.p_registration_token, 'synthetic-registration-token', 'Stable registration identity retained');
equal(calls[0].args.p_registration_data.walkInReservation, { reservationId: reservation.reservationId, doctorId: reservation.doctorId,
  doctorName: reservation.doctorName, specialization: '', slotDate: reservation.date, slotTime: reservation.time }, 'Doctor/date/time contract unchanged');
equal(context.view, 'confirmation', 'Existing access/QR handoff screen reached');

// Actual Proceed/Resume handlers and layout effect, with synthetic scroll owners/RPC only.
for (const name of ['reserveSelectedWalkInSlot', 'resumeActiveWalkInRegistration']) install(name);
const entryEffect = find(tree, node => node.type === 'CallExpression' && node.callee?.name === 'useLayoutEffect');
check(entryEffect, 'Registration entry reset uses layout phase');
let scrollCount = 0, lastScreen, capturedEffect;
const mainScroll = { scrollTop: 600, scrollTo(options) { this.scrollTop = options.top; equal(options.behavior, 'instant', 'No animated navigation jump'); } };
context.registrationTopRef = { current: { closest(selector) { equal(selector, '.doctor-main', 'Targets actual desktop scroll owner'); return mainScroll; } } };
context.registrationEntryScrollRef = { current: false };
context.window = { ...context.window, scrollY: 600, scrollTo(options) { this.scrollY = options.top; scrollCount++; } };
context.useLayoutEffect = (callback, dependencies) => {
  equal(serial(dependencies), [context.screen], 'Only screen transition is a reset dependency');
  capturedEffect = callback;
  if (lastScreen !== context.screen) { lastScreen = context.screen; callback(); }
};
const commitScreen = () => vm.runInContext(source.slice(...entryEffect.range), context);
context.screen = 'select-slot'; context.setScreen = value => { context.screen = value; };
context.location = { pathname: '/staff/patients/new/select-slot' };
context.navigate = path => { context.location.pathname = path; };
context.activeWalkInReservation = null; context.selectedDoctor = { id: 'synthetic-doctor', name: 'Synthetic Doctor' };
context.selectedSlot = { id: 'synthetic-slot', status: 'available', time: '09:00' }; context.selectedDate = '2026-10-22';
context.setIsReservingSlot = () => {}; context.setWalkInError = () => {}; context.setWalkInNotice = () => {};
context.persistWalkInSlot = value => { context.selectedWalkInSlot = value; };
context.supabase = { rpc: async name => { equal(name, 'reserve_walkin_registration_slot', 'Existing reservation contract');
  return { data: { reservation_id: 'synthetic-new-reservation', expires_at: '2050-01-01T00:00:00Z' }, error: null }; } };
const draftBeforeEntry = serial(context.form);
commitScreen(); await vm.runInContext('reserveSelectedWalkInSlot()', context);
equal(context.location.pathname, '/staff/patients/new/register', 'Proceed keeps existing destination');
check(context.registrationEntryScrollRef.current, 'Successful reservation arms entry reset');
equal(scrollCount, 0, 'No reset before registration is committed');
context.screen = 'register'; commitScreen();
equal([mainScroll.scrollTop, context.window.scrollY], [0, 0], 'Desktop and mobile scroll owners reset to top');
equal(context.registrationEntryScrollRef.current, false, 'Reset flag consumed once');
equal(context.form, draftBeforeEntry, 'Entry reset preserves full registration draft');
equal([context.selectedWalkInSlot.doctorId, context.selectedWalkInSlot.date, context.selectedWalkInSlot.time],
  ['synthetic-doctor', '2026-10-22', '09:00'], 'Selected Doctor/date/time retained');
mainScroll.scrollTop = 400; context.window.scrollY = 400;
vm.runInContext('updateForm("name", "Maria")', context); context.step = 2; commitScreen(); capturedEffect();
equal([mainScroll.scrollTop, context.window.scrollY, scrollCount], [400, 400, 1], 'Typing/step rendering/effect replay never repeat entry reset');
context.screen = 'select-slot'; commitScreen(); context.screen = 'register'; commitScreen();
equal([mainScroll.scrollTop, context.window.scrollY, scrollCount], [400, 400, 1], 'Unarmed browser Back/Forward entry leaves scroll alone');
context.screen = 'select-slot'; commitScreen(); context.activeWalkInReservation = context.selectedWalkInSlot;
context.reservedDoctor = context.selectedDoctor;
await vm.runInContext('resumeActiveWalkInRegistration()', context); commitScreen();
equal([context.screen, mainScroll.scrollTop, context.window.scrollY, scrollCount], ['register', 0, 0, 2], 'Explicit Resume gets one fresh entry reset');
context.activeWalkInReservation = null; context.screen = 'select-slot'; commitScreen();
context.console = { ...console, error() {} };
context.supabase = { rpc: async () => ({ data: null, error: { message: 'Synthetic reservation failure' } }) };
await vm.runInContext('reserveSelectedWalkInSlot()', context);
equal([context.registrationEntryScrollRef.current, context.screen, scrollCount], [false, 'select-slot', 2], 'Failed reservation cannot arm or execute entry reset');

// Actual three step JSX: accessible errors, preserved fields, readable placeholders.
const renderNode = find(tree, node => node.type === 'VariableDeclarator' && node.id?.name === 'renderStepContent');
const renderedCode = (await transformWithOxc('const ' + source.slice(...renderNode.range) + '; export {renderStepContent};', file,
  { jsx: { runtime: 'automatic', development: false } })).code;
const renderer = new vm.SourceTextModule(renderedCode, { context });
await renderer.link(spec => {
  assert.equal(spec, 'react/jsx-runtime');
  return new vm.SyntheticModule(Object.keys(jsxRuntime), function () {
    for (const [key, value] of Object.entries(jsxRuntime)) this.setExport(key, value);
  }, { context });
});
await renderer.evaluate();
context.renderStepContent = renderer.namespace.renderStepContent;
context.Icon = () => null;
context.setRegistrationFieldRef = () => undefined; context.isEditingRegistrationReview = false;
context.continueRegistrationStep = blocked; context.moveToRegistrationStep = blocked; context.reviewRegistration = blocked;
context.addPregnancyRecord = blocked; context.addAllergyRecord = blocked; context.updateAllergyRecord = blocked;
context.removeAllergyRecord = blocked; context.toggleArrayValue = blocked; context.backToPatients = blocked;
const markup = [];
for (const step of [1, 2, 3]) {
  context.step = step; context.form = serial(base); context.registrationErrors = {};
  markup.push(renderToStaticMarkup(vm.runInContext('renderStepContent()', context)));
}
check(markup[0].includes('1. Basic Information') && markup[1].includes('2. Reproductive &amp; Obstetric History') && markup[2].includes('3. Medical &amp; Family History'), 'All original three steps render');
check(markup[0].includes('Maria Dela Cruz') && markup[1].includes('e.g., 12') && markup[1].includes('e.g., 28'), 'Helpful placeholders render');
check(markup[0].includes('registration-partner-name') && markup[1].includes('registration-edd'), 'Newly validated fields retain accessible targets');
check(markup[1].includes('inputMode="numeric"') && !markup[1].includes('type="number"'), 'Mobile numeric keyboard without coercive number inputs');
context.step = 2; context.form = { ...serial(base), pregnancyRecords: [{ id: 'test', birthdate: '' }] };
context.registrationErrors = { edd: 'Invalid EDD', 'pregnancyBirthdate-0': 'Invalid history date' };
const errorHtml = renderToStaticMarkup(vm.runInContext('renderStepContent()', context));
check(errorHtml.includes('registration-edd-error') && errorHtml.includes('registration-pregnancy-0-error') && errorHtml.includes('aria-invalid="true"'), 'Date errors have connected accessible descriptions');

// No allergy convention, registration lifecycle or protected clinical code may change here.
const head = execFileSync('git', ['show', 'HEAD:' + file], { encoding: 'utf8' });
const headTree = parse(head, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
for (const name of ['allergyTypeOptions', 'normalizeStructuredAllergies', 'formatAllergyEntry', 'getAllergyList',
  'addAllergyRecord', 'updateAllergyRecord', 'removeAllergyRecord', 'findRegistrationConflict', 'finishRegistration',
  'renderConfirmationContent', 'createReservedPatientLoginPayload', 'createPatientLoginPayload', 'PatientRegisterSuccessCard']) {
  const locate = ast => find(ast, n => ['FunctionDeclaration', 'VariableDeclarator'].includes(n.type) && n.id?.name === name);
  const semantic = node => JSON.stringify(node, (key, value) => ['range', 'start', 'end', 'raw'].includes(key) ? undefined : value);
  equal(semantic(locate(tree)), semantic(locate(headTree)), name + ' logic unchanged apart from comments/formatting');
}
const payload = actual.createRegistrationDataPayload({ ...base, allergies: [{ id: 'synthetic-allergy', type: 'food', allergen: 'Peanut', reaction: 'Rash' }] }, reservation);
equal(payload.allergies, [{ id: 'synthetic-allergy', type: 'food', allergen: 'Peanut', reaction: 'Rash' }], 'Allergy payload unchanged');
equal(actual.createRegistrationDataPayload(base, reservation).allergies, [], 'Unanswered allergy remains unanswered');
equal(actual.steps.length, 3, 'No basic-only wizard substitution');

// Render the actual registration shell around each actual step; no application session.
const shellNode = find(tree, node => node.type === 'JSXElement' && node.openingElement.attributes.some(item =>
  item.name?.name === 'className' && item.value?.value === 'staff-register-page'));
assert.ok(shellNode, 'Actual registration shell');
const shellCode = (await transformWithOxc('const renderShell = () => (' + source.slice(...shellNode.range) + '); export {renderShell};', file,
  { jsx: { runtime: 'automatic', development: false } })).code;
const shell = new vm.SourceTextModule(shellCode, { context });
await shell.link(spec => {
  assert.equal(spec, 'react/jsx-runtime');
  return new vm.SyntheticModule(Object.keys(jsxRuntime), function () {
    for (const [key, value] of Object.entries(jsxRuntime)) this.setExport(key, value);
  }, { context });
});
await shell.evaluate();
context.registrationTopRef = { current: null }; context.statusMessage = '';
context.registrationView = 'form'; context.registrationErrors = {};
for (const step of [1, 2, 3]) {
  context.step = step; context.form = serial(base);
  const html = renderToStaticMarkup(shell.namespace.renderShell());
  equal((html.match(/<h3>Patient Access<\/h3>/g) || []).length, 0, 'Step ' + step + ': informational access card removed');
  check(html.indexOf('staff-register-stepper') < html.indexOf('<main') && !html.includes('staff-register-access'), 'Step ' + step + ': progress directly precedes form, no empty access wrapper');
  check(!html.includes('staff-register-side'), 'Step ' + step + ': no reserved sidebar element');
  check(html.includes(markup[step - 1]), 'Step ' + step + ': field grouping/controls unchanged inside wider shell');
  check(!html.includes('Complete all required Patient information to generate'), 'Step ' + step + ': removed informational copy is absent');
}
const css = postcss.parse(await readFile(new URL('../src/styles/staff-patients.css', import.meta.url), 'utf8'));
function lastDeclaration(selector, property) {
  let value;
  css.walkRules(rule => {
    if (rule.selector === selector) rule.walkDecls(property, declaration => { value = declaration.value; });
  });
  return value;
}
equal(lastDeclaration('.staff-dashboard-shell .staff-register-page:not(.staff-walkin-page) .staff-register-workspace', 'grid-template-columns'),
  'minmax(0, 1fr)', 'Scoped workspace removes the second column');
equal(lastDeclaration('.staff-dashboard-shell .staff-register-page .staff-register-main-column', 'max-width'), '1120px', 'Form width capped');
equal(lastDeclaration('.staff-dashboard-shell .staff-register-page .staff-register-access', 'justify-self'), 'center', 'Access centered in shared flow');
equal(lastDeclaration('.staff-dashboard-shell .staff-register-access .staff-register-credential-card.is-placeholder', 'min-height'), '0', 'Tall placeholder minimum removed');
equal(lastDeclaration('.staff-dashboard-shell .staff-register-access .staff-register-credential-card.is-placeholder', 'grid-template-columns'),
  '42px minmax(0, 1fr)', 'Compact icon and wrapping copy');
check(!lastDeclaration('.staff-dashboard-shell .staff-register-page .staff-register-access', 'position'), 'Access stays in natural document flow');

// New Staff registrations require email; existing blank-email directory/activation paths stay separate.
for (const email of ['', '   ', null, undefined]) {
  equal(actual.getStepOneValidationErrors({ ...base, email }).email, 'Patient email address is required.', 'Missing email has clear inline error');
  rejects(() => actual.createRegistrationDataPayload({ ...base, email }, null), 'Missing email cannot enter final RPC payload');
}
for (const email of ['patient', 'patient@', '@example.test', 'patient@example', 'patient @example.test', 'patient@example.test other']) {
  equal(actual.getStepOneValidationErrors({ ...base, email }).email, 'Enter a valid Patient email address.', 'Invalid email has clear inline error');
  rejects(() => actual.createRegistrationDataPayload({ ...base, email }, null), 'Invalid email cannot enter final RPC payload');
}
for (const email of ['Patient@Example.TEST', '  patient@example.test  ', 'patient+care@example.test']) {
  equal(actual.getStepOneValidationErrors({ ...base, email }), {}, 'Valid email accepted');
  equal(actual.createRegistrationDataPayload({ ...base, email }, reservation).email, email.trim().toLowerCase(), 'Payload trims and normalizes casing');
}
const emailNode = find(tree, node => node.type === 'JSXElement' && node.openingElement.name.name === 'InputField' &&
  node.openingElement.attributes.some(a => a.name?.name === 'fieldId' && a.value?.value === 'registration-email'));
check(emailNode.openingElement.attributes.some(a => a.name?.name === 'required'), 'Email field sets existing required indicator');
context.form = { ...serial(base), email: '  Patient@Example.TEST  ' }; context.registrationErrors = {};
const blur = emailNode.openingElement.attributes.find(a => a.name?.name === 'onBlur').value.expression;
vm.runInContext('(' + source.slice(...blur.range) + ')()', context);
equal(context.form.email, 'patient@example.test', 'Actual email blur handler normalizes state');
check(markup[0].includes('Email Address<b>*</b>') && markup[0].includes('Enter patient&#x27;s email address'), 'Required label and requested placeholder rendered');
check(/type="email"[^>]*required=""/.test(markup[0]), 'Native email input is actually required');
context.step = 1; context.form = serial(base); context.registrationErrors = { email: 'Patient email address is required.' };
const emailErrorHtml = renderToStaticMarkup(vm.runInContext('renderStepContent()', context));
check(emailErrorHtml.includes('registration-email-error') && emailErrorHtml.includes('aria-describedby="registration-email-error"') && emailErrorHtml.includes('Patient email address is required.'), 'Inline error is associated with email input');
const transport = available['../../lib/supabaseClient'].supabase;
let duplicateReads = 0;
transport.rpc = name => { equal(name, 'get_staff_patient_directory', 'Duplicate check keeps authorized directory RPC'); duplicateReads++; return {select: async () => ({ data: [
  { id:'existing-patient', patient_id:'LP-2030-00001', full_name:'Different Family Member', date_of_birth:'1990-01-01', email:'  PATIENT@Example.Test  ' },
  { id:'same-name', patient_id:'LP-2030-00002', full_name:'  MARIA   DELA CRUZ ', date_of_birth:base.birthdate, email:'' },
], error:null })}; };
equal((await actual.findRegistrationConflict({ ...base, email:' patient@example.test ' }, null)).kind, 'email', 'Normalized duplicate email rejected across different names/family members');
equal((await actual.findRegistrationConflict({ ...base, email:'unique@example.test' }, null)).kind, 'identity', 'Normalized name plus DOB duplicate preserved even on blank-email historical record');
equal(await actual.findRegistrationConflict({ ...base, name:'Unique New Patient', email:'unique@example.test' }, null), null, 'Unique email and identity accepted');
equal(await actual.findRegistrationConflict({ ...base, name:'Unique New Patient', email:'patient@example.test' }, 'existing-patient'), null, 'Existing own draft excluded from duplicate comparison');
check(duplicateReads === 4, 'Duplicate helper uses one authorized directory read per attempt');
let duplicateWrites = 0;
context.isSavingPatient = false; context.registrationRecord = null; context.registrationToken = 'synthetic-registration-token';
context.findRegistrationConflict = actual.findRegistrationConflict;
context.supabase = { rpc: () => { duplicateWrites++; throw Error('Duplicate must not reach save'); } };
context.setStatusMessage = value => { context.statusMessage = value; };
for (const [email, expected] of [['patient@example.test', 'Email already registered'], ['unique@example.test', 'Possible duplicate Patient']]) {
  context.form = { ...serial(base), email };
  await vm.runInContext('generatePatientAccess()', context);
  equal(duplicateWrites, 0, 'Actual Generate stops duplicates before save RPC');
  check(context.statusMessage.includes(expected), 'Actual Generate preserves clear duplicate feedback');
}
transport.rpc = blocked;
const legacy = { id:'legacy-blank-email', patient_id:'LP-2020-00001', full_name:'Synthetic Legacy Patient', date_of_birth:'1990-01-01', email:null, user_id:null };
equal(actual.mapSupabasePatient(legacy).recordId, legacy.id, 'Blank-email historical patient still maps into directory normally');
equal(legacy.email, null, 'Historical blank email is not backfilled or mutated');
equal(actual.CredentialsPanel({ credentials:null }), null, 'Missing credentials render no informational card');
const generated = renderToStaticMarkup(React.createElement(actual.CredentialsPanel, { credentials: { patientId:'LP-2030-00003', controlNumber:'SYNTHETIC-ONLY' } }));
check(generated.includes('LP-2030-00003') && generated.includes('SYNTHETIC-ONLY') && generated.includes('<svg'), 'Generated Patient ID, one-time control and QR component retained');
// Execute actual Next and Generate handlers: missing/invalid email stops before token allocation or RPC.
for (const name of ['continueRegistrationStep', 'moveToRegistrationStep']) install(name);
let allocations = 0, writes = 0;
context.registrationRecord = null; context.registrationToken = ''; context.isSavingPatient = false;
context.selectedWalkInSlot = reservation; context.step = 1; context.isEditingRegistrationReview = false;
context.setStep = value => { context.step = value; }; context.setRegistrationView = value => { context.registrationView = value; };
context.setStatusMessage = () => {}; context.focusRegistrationField = () => {}; context.scrollRegistrationToTop = () => {};
context.createRegistrationToken = () => { allocations++; throw Error('Invalid email reached credentials'); };
context.supabase = { rpc: () => { writes++; throw Error('Live registration forbidden'); } };
for (const email of ['', ' ', null, 'invalid', 'patient@example']) {
  context.form = { ...serial(base), email }; context.step = 1;
  vm.runInContext('continueRegistrationStep(2)', context);
  equal(context.step, 1, 'Missing/invalid email cannot advance Step 1');
  check(Boolean(context.errors.email), 'Actual step gate records inline email error');
  await vm.runInContext('generatePatientAccess()', context);
  equal([allocations, writes], [0, 0], 'Missing/invalid email cannot allocate credentials or call save RPC');
}
context.form = serial(base); context.step = 1;
vm.runInContext('continueRegistrationStep(2)', context); equal(context.step, 2, 'Valid email permits Step 2');
vm.runInContext('moveToRegistrationStep(1)', context); equal(context.form.email, base.email, 'Back preserves email');
vm.runInContext('continueRegistrationStep(2)', context); vm.runInContext('continueRegistrationStep(3)', context);
equal([context.step, context.form.email, context.selectedWalkInSlot], [3, base.email, reservation], 'Next reaches third step without changing email or selected Doctor/date/time/reservation');
console.log(`PASS: ${checks} registration validation/layout assertions. Actual functions/handlers/SSR and CSS-source checks; synthetic transport only. No browser layout or production registration test claimed.`);
