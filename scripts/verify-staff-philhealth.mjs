// Actual Staff validation, payload and JSX with synthetic inputs only; no backend requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'espree';
import { transformWithOxc } from 'vite';
import * as dates from '../src/lib/appointmentDate.js';
import { isValidPhilippineMobileNumber } from '../src/lib/philippinePhone.js';

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const path = 'src/pages/staff/Staff_Patients.jsx';
const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
const blocked = () => { throw Error('No network or application action is allowed in this fixture'); };
const context = vm.createContext({ React, console, Date, window: {}, URLSearchParams });
const declarations = tree.body.filter(n => n.type === 'ImportDeclaration');
const imports = {
  react: { ...React, default: React }, 'react/jsx-runtime': jsxRuntime,
  '../../lib/appointmentDate': dates,
  '../../lib/philippinePhone': { isValidPhilippineMobileNumber },
  '../../lib/supabaseClient': { supabase: { from: blocked, rpc: blocked } },
};
const code = (await transformWithOxc(source + '\nexport { blankForm, getStepOneValidationErrors, normalizeRegistrationHistoryFields, createRegistrationDataPayload, RadioGroup, InputField, isAllowedRegistrationInput, getRegistrationInputRestriction };', path, { jsx: { runtime: 'automatic', development: false } })).code;
const module = new vm.SourceTextModule(code, { context });
await module.link(spec => {
  const entry = declarations.find(n => n.source.value === spec);
  const values = imports[spec] || Object.fromEntries(entry.specifiers.map(s => [s.type === 'ImportDefaultSpecifier' ? 'default' : s.imported.name,
    spec === '@iconify/react' ? () => null : blocked]));
  return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
});
await module.evaluate();
const actual = module.namespace;
let checks = 0;
function equal(a, b, label) { assert.deepEqual(a, b, label); checks++; }
const serial = value => JSON.parse(JSON.stringify(value));
const base = { ...serial(actual.blankForm), name: 'Synthetic Patient', email: 'patient@example.test', birthdate: '1995-01-01', civilStatus: 'Single',
  address: 'Synthetic address', contactNumber: '09171234567', emergencyContactPerson: 'Synthetic Contact',
  emergencyContactRelationship: 'Partner', emergencyContactNumber: '09181234567' };
for (const value of ['', null, undefined, 'Unknown', 'Maybe']) {
  equal(Boolean(actual.getStepOneValidationErrors({ ...base, philHealthMember: value }).philHealthMember), true, 'Unanswered/unsupported enrollment cannot complete registration');
}
for (const pin of ['', ' ', 'No', 'abc071234567891', '-071234567891', '07123456789', '0712345678912', '07-123-456789-1', '071234567891.0', '07 123456789 1']) {
  equal(Boolean(actual.getStepOneValidationErrors({ ...base, philHealthMember: 'Yes', philHealthPin: pin }).philHealthPin), true, 'Yes requires a complete strictly formatted PIN');
}
for (const pin of ['071234567891', '07-123456789-1', ' 07-123456789-1 ']) {
  equal(serial(actual.getStepOneValidationErrors({ ...base, philHealthMember: 'Yes', philHealthPin: pin })), {}, '12 digits or documented 2-9-1 format accepted');
}
equal(serial(actual.getStepOneValidationErrors({ ...base, philHealthMember: 'No', philHealthPin: '' })), {}, 'Explicit No needs no PIN');
for (const membership of [true, 'Yes', false, 'No', null, undefined, '']) {
  const restored = actual.normalizeRegistrationHistoryFields({ ...base, philHealthMember: membership, philHealthPin: '071234567891' });
  const expected = membership === true || membership === 'Yes' ? 'Yes' : membership === false || membership === 'No' ? 'No' : '';
  equal(restored.philHealthMember, expected, 'Boolean draft status restores without inventing No');
  equal(restored.philHealthPin, expected === 'Yes' ? '071234567891' : '', 'Only Yes retains PIN');
}
for (const membership of ['Yes', 'No', '']) {
  const form = { ...base, philHealthMember: membership, philHealthPin: '071234567891' };
  const payload = actual.createRegistrationDataPayload(form, null);
  equal(payload.philHealthMember, membership, 'Existing RPC key/status contract preserved');
  equal(payload.philHealthPin, membership === 'Yes' ? '071234567891' : '', 'No/unknown submit no PIN, never the literal No');
  equal(form.philHealthPin, '071234567891', 'Payload mapping does not mutate historical caller data');
  const restored = actual.normalizeRegistrationHistoryFields(serial(payload));
  equal(restored.philHealthMember, membership, 'Payload/draft restoration is consistent');
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const v of Object.values(node)) for (const child of Array.isArray(v) ? v : [v]) { const result = find(child, predicate); if (result) return result; }
  return null;
}
const section = find(tree, n => n.type === 'JSXElement' && n.openingElement.name.name === 'div' &&
  n.children.some(child => child.type === 'JSXElement' && child.openingElement.name.name === 'RadioGroup' &&
    child.openingElement.attributes.some(a => a.name?.name === 'name' && a.value?.value === 'registration-philhealth-membership')));
assert.ok(section, 'Actual Staff PhilHealth section');
context.RadioGroup = actual.RadioGroup; context.InputField = actual.InputField;
context.updateForm = blocked; context.setRegistrationFieldRef = () => undefined;
context.require = spec => { assert.equal(spec, 'react/jsx-runtime'); return jsxRuntime; };
const compiled = (await transformWithOxc('function RenderPhilHealth() { return (' + source.slice(...section.range) + '); }', path, { jsx: { runtime: 'automatic', development: false } })).code;
vm.runInContext(compiled, context);
function render(membership, pin = '', errors = {}) {
  context.form = { ...base, philHealthMember: membership, philHealthPin: pin };
  context.registrationErrors = errors;
  return renderToStaticMarkup(React.createElement(context.RenderPhilHealth));
}
for (const membership of ['', 'Yes', 'No']) {
  const html = render(membership);
  equal((html.match(/type="radio"/g) || []).length, 2, 'Only Yes and No selectable');
  equal(html.includes('registration-philhealth-pin'), membership === 'Yes', 'PIN input visible only for Yes');
  equal((html.match(/ checked=""/g) || []).length, membership ? 1 : 0, 'Unanswered is never preselected as No');
}
const invalidHtml = render('Yes', '', { philHealthPin: 'PIN required' });
equal(invalidHtml.includes('aria-invalid="true"'), true, 'Invalid PIN is accessible');
equal(invalidHtml.includes('registration-philhealth-pin-error'), true, 'PIN error is connected to its input');
equal(invalidHtml.includes('PIN required'), true, 'Required PIN error visible');
const missingHtml = render('', '', { philHealthMember: 'Select Yes or No' });
equal(missingHtml.includes('registration-philhealth-membership-error'), true, 'Membership error has an accessible description');

const update = find(tree, n => n.type === 'VariableDeclarator' && n.id?.name === 'updateForm');
context.isAllowedRegistrationInput = actual.isAllowedRegistrationInput;
context.getRegistrationInputRestriction = actual.getRegistrationInputRestriction;
context.clearResolvedRegistrationError = () => {};
context.setForm = value => { context.form = value; };
vm.runInContext('const ' + source.slice(...update.range) + ';', context);
context.form = { ...base, philHealthMember: 'Yes', philHealthPin: '071234567891' };
vm.runInContext('updateForm("philHealthMember", "No")', context);
equal(context.form.philHealthPin, '', 'Actual Yes-to-No handler clears stale PIN');
vm.runInContext('updateForm("philHealthMember", "Yes")', context);
equal(context.form.philHealthPin, '', 'Switching back to Yes does not invent a PIN');
equal(Boolean(actual.getStepOneValidationErrors(context.form).philHealthPin), true, 'Switching back to Yes requires PIN again');

// Exercise the actual step gate and Generate Patient Access handler, not a duplicate validator.
for (const name of ['validateRegistrationStep', 'generatePatientAccess']) {
  const node = find(tree, n => n.type === 'VariableDeclarator' && n.id?.name === name);
  vm.runInContext('const ' + source.slice(...node.range) + ';', context);
}
let allocations = 0;
context.steps = [1, 2, 3]; context.registrationRecord = null;
context.selectedWalkInSlot = { reservationId: 'synthetic-reservation' }; context.isSavingPatient = false;
context.getStepOneValidationErrors = actual.getStepOneValidationErrors;
context.setRegistrationErrors = errors => { context.errors = errors; };
context.setStatusMessage = () => {}; context.setStep = () => {}; context.setRegistrationView = () => {};
context.focusRegistrationField = () => {}; context.scrollRegistrationToTop = () => {};
context.createRegistrationToken = () => { allocations++; throw Error('Invalid PhilHealth reached credential allocation'); };
for (const fields of [{ philHealthMember: '' }, { philHealthMember: 'Yes', philHealthPin: '' }, { philHealthMember: 'Yes', philHealthPin: 'abc123' }]) {
  context.form = { ...base, ...fields };
  await vm.runInContext('generatePatientAccess()', context);
  equal(Object.keys(context.errors).some(key => key.startsWith('philHealth')), true, 'Actual submit stops at PhilHealth validation');
  equal(allocations, 0, 'Invalid enrollment/PIN never reaches credentials or registration RPC');
}

const reviewMembership = find(tree, n => n.type === 'JSXElement' && n.openingElement.name.name === 'div' &&
  n.children.some(c => c.type === 'JSXElement' && c.openingElement.name.name === 'dt' && c.children.some(t => t.type === 'JSXText' && t.value === 'PhilHealth member')));
const reviewPin = find(tree, n => n.type === 'JSXElement' && n.openingElement.name.name === 'div' &&
  n.children.some(c => c.type === 'JSXElement' && c.openingElement.name.name === 'dt' && c.children.some(t => t.type === 'JSXText' && t.value === 'PhilHealth PIN')));
assert.ok(reviewMembership && reviewPin, 'Actual registration review fields');
vm.runInContext((await transformWithOxc('function RenderReview() { return (<dl>' + source.slice(...reviewMembership.range) + source.slice(...reviewPin.range) + '</dl>); }', path, { jsx: { runtime: 'automatic', development: false } })).code, context);
for (const member of ['Yes', 'No', '']) {
  const payload = actual.createRegistrationDataPayload({ ...base, philHealthMember: member, philHealthPin: '071234567891' }, null);
  context.form = actual.normalizeRegistrationHistoryFields(serial(payload));
  const html = renderToStaticMarkup(React.createElement(context.RenderReview));
  equal(html.includes('<dt>PhilHealth member</dt><dd>' + (member || 'Not recorded') + '</dd>'), true, 'Review membership matches payload/restored draft');
  equal(html.includes('<dt>PhilHealth PIN</dt><dd>' + (member === 'Yes' ? '071234567891' : 'Not recorded') + '</dd>'), true, 'Review PIN matches explicit membership');
}

const sql = await readFile(new URL('../supabase/migrations/20261006120000_add_patient_philhealth_and_gtpal.sql', import.meta.url), 'utf8');
equal(sql.includes('add column philhealth_member boolean'), true, 'Existing nullable enrollment column');
equal(sql.includes('add column philhealth_pin text'), true, 'PIN is text; no numeric coercion');
equal(sql.includes("when 'no' then false when 'false' then false"), true, 'Existing RPC distinguishes explicit false from unknown');
equal(/if resolved_philhealth_member is distinct from true then\s+resolved_philhealth_pin := null;/.test(sql), true, 'Existing RPC stores no PIN for No/unknown');
console.log(`PASS: ${checks} Staff PhilHealth checks. Actual validation/payload/JSX; SQL-source checks only, no Supabase persistence or eligibility verification.`);
