// Production JSX/handlers with synthetic React/DOM. No Auth, storage or browser access.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import * as vm from "node:vm";
import { transformWithOxc } from "vite";
import postcss from "postcss";
import * as clinicStatus from "../src/lib/clinicAccountStatus.js";
if (!vm.SourceTextModule) {
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
const root = new URL("../", import.meta.url);
const source = async path => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
let checks = 0, nextId = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const element = (type, props) => ({ type, props: props || {} });
const jsx = { jsx: element, jsxs: element, Fragment: "Fragment" };
const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const regression = await source("scripts/verify-doctor-dashboard-batch2.mjs");
const start = regression.indexOf("function hooksRuntime()"), end = regression.indexOf("const element", start);
const hooksRuntime = new Function(regression.slice(start, end) + ";return hooksRuntime;")();
function runtime() {
  const hooks = hooksRuntime();
  // Model React useId's stable per-instance identity using the existing ref slots.
  hooks.runtime.useId = () => hooks.runtime.useRef('synthetic-instance-' + (++nextId)).current;
  return hooks;
}
async function evaluate(code, name, mocks, context) {
  code = (await transformWithOxc(code, name, { jsx: { runtime: "automatic" } })).code;
  const module = new vm.SourceTextModule(code, { context, identifier: name });
  await module.link(specifier => {
    const values = specifier.endsWith('.css') ? {} : mocks[specifier];
    if (!values) throw Error('Unmocked import ' + specifier);
    return new vm.SyntheticModule(Object.keys(values), function() {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate(); return module.namespace;
}
const keyEvent = (key, currentTarget) => ({ key, currentTarget, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
const identity = { profile: { id: 'doctor-a', role: 'doctor', account_status: 'active' },
  doctorDisplayName: 'Synthetic Doctor', doctorEmail: 'doctor@example.test',
  personalInformation: { full_name: 'Synthetic Doctor', gender: 'Female' },
  professionalInformation: { license_number: 'LICENSE-FIXTURE', clinic_address: 'Fixture Clinic' } };
async function profileHarness() {
  const hooks = runtime(), navigations = [], dom = new Map();
  let activeElement = null;
  const module = await evaluate(await source('src/pages/doctor/Doctor_ViewProfile.jsx'), 'profile.jsx', {
    react: hooks.runtime, 'react/jsx-runtime': jsx, 'react-router-dom': { useNavigate: () => path => navigations.push(path) },
    '@iconify/react': { Icon: 'Icon' }, '../../components/common/ProfilePictureActions': { default: 'PhotoActions' },
    '../../components/common/ProfileAvatarContent': { default: 'Avatar' },
    '../../hooks/useDoctorProfileSummary': { useDoctorProfileSummary: () => ({ status: 'ready', summary: { cancelled: 35, today: 0, pending: 7, completed: 5 } }) },
    '../../lib/clinicAccountStatus': clinicStatus,
  }, vm.createContext({}));
  hooks.mount(module.default, { doctorIdentity: identity }, view => {
    const tabs = nodes(view).filter(node => node.props.role === 'tab');
    const parent = { querySelectorAll: () => tabs.map(tab => dom.get(tab.props.id)) };
    for (const tab of tabs) {
      if (!dom.has(tab.props.id)) dom.set(tab.props.id, { focus() { activeElement = this; } });
      const button = dom.get(tab.props.id); button.parentElement = parent; button.props = tab.props;
    }
  });
  return { hooks, navigations, dom, get activeElement() { return activeElement; },
    tabs: () => nodes(hooks.result).filter(node => node.props.role === 'tab'),
    panels: () => nodes(hooks.result).filter(node => node.props.role === 'tabpanel') };
}
{
  const h = await profileHarness(), originalIds = h.tabs().map(tab => tab.props.id);
  check(nodes(h.hooks.result).some(node => node.props.role === 'tablist' && node.props['aria-label'] === 'Profile information'), 'Profile tablist has accessible name');
  check(h.tabs().length === 2 && h.panels().length === 2, 'Both tabs have persistent panels');
  const assertSelection = index => {
    const tabs = h.tabs(), panels = h.panels();
    check(tabs.filter(tab => tab.props.tabIndex === 0).length === 1 && tabs[index].props.tabIndex === 0, 'Only selected tab is sequentially focusable');
    check(tabs[index].props['aria-selected'] && !tabs[1-index].props['aria-selected'], 'Selected state follows active tab');
    check(!panels[index].props.hidden && panels[1-index].props.hidden, 'Only selected panel is exposed');
    for (const [n, tab] of tabs.entries()) {
      check(tab.props['aria-controls'] === panels[n].props.id && panels[n].props['aria-labelledby'] === tab.props.id, 'Bidirectional tab/panel association');
      check(panels[n].props.tabIndex === 0, 'Read-only panel is a keyboard reading target');
    }
  };
  assertSelection(0);
  for (const [from, key, target] of [[0,'ArrowRight',1],[1,'ArrowRight',0],[0,'ArrowLeft',1],[1,'ArrowLeft',0],[0,'End',1],[1,'Home',0]]) {
    const tab = h.tabs()[from], event = keyEvent(key, h.dom.get(tab.props.id));
    tab.props.onKeyDown(event); h.hooks.flush();
    check(event.prevented && h.activeElement === h.dom.get(h.tabs()[target].props.id), key + ' activates and focuses destination');
    assertSelection(target);
  }
  for (const key of ['Tab', 'ArrowUp', 'Escape', 'Enter', ' ']) {
    const before = h.tabs().map(tab => tab.props['aria-selected']).join();
    const tab = h.tabs()[0], event = keyEvent(key, h.dom.get(tab.props.id)); tab.props.onKeyDown(event); h.hooks.flush();
    check(!event.prevented && h.tabs().map(tab => tab.props['aria-selected']).join() === before, key + ' retains native behavior');
  }
  // Native button activation is represented by its click callback; real Enter/
  // Space event synthesis belongs to the browser checklist.
  h.tabs()[1].props.onClick(); h.hooks.flush(); assertSelection(1);
  h.tabs()[0].props.onClick(); h.hooks.flush(); assertSelection(0);
  check(h.tabs().map(tab => tab.props.id).join() === originalIds.join(), 'IDs remain stable after keyboard and mouse activation');
  const focused = h.activeElement;
  h.hooks.update({ doctorIdentity: { ...identity, doctorDisplayName: 'Refreshed Doctor' } });
  check(h.activeElement === focused && h.tabs().map(tab => tab.props.id).join() === originalIds.join(), 'Normal identity refresh does not reset tab focus or IDs');
  const second = await profileHarness();
  check(!second.tabs().some(tab => originalIds.includes(tab.props.id)), 'Separate Profile instances have unique IDs');
  check(nodes(h.panels()[0]).some(node => node.props.item?.label === 'Full Name') && nodes(h.panels()[1]).some(node => node.props.item?.value === 'LICENSE-FIXTURE'), 'Personal and Professional contents retain the correct fields');
  const summary = nodes(h.hooks.result).find(node => node.props['aria-label'] === 'Open Pending appointments'); summary.props.onClick();
  check(h.navigations[0] === '/doctor/appointments?status=pending', 'Summary navigation is preserved');
  second.hooks.unmount(); h.hooks.unmount();
}
const css = postcss.parse(await source('src/styles/doctor-viewprofile.css'));
let hidesInactive = false;
css.walkRules('.doctor-dashboard .doctor-profile-tab-content[hidden]', rule => {
  hidesInactive = rule.nodes.some(node => node.prop === 'display' && node.value === 'none');
});
check(hidesInactive, 'Hidden panels stay hidden despite grid display cascade');
async function avatarHarness(props = {}, options = {}) {
  const hooks = runtime(), listeners = new Map(), dom = new Map(), calls = [], changes = [];
  const doc = {
    activeElement: null,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, event) { for (const fn of [...(listeners.get(name) || [])]) fn(event); },
  };
  const callback = (...args) => changes.push(args);
  const initialProps = { onChange: callback, ...props };
  const module = await evaluate(await source('src/components/common/ProfilePictureActions.jsx'), 'avatar.jsx', {
    react: hooks.runtime, 'react/jsx-runtime': jsx, '@iconify/react': { Icon: 'Icon' },
    '../../lib/profilePicture': {
      uploadProfilePicture: async (file, scope) => { calls.push({ type: 'upload', file, scope }); return options.upload ? options.upload(file, scope) : { displayUrl: 'saved-photo', storedValue: 'saved-value' }; },
      removeProfilePicture: async scope => { calls.push({ type: 'remove', scope }); return options.remove ? options.remove(scope) : { displayUrl: '', storedValue: '' }; },
    },
  }, vm.createContext({ AbortController, document: doc }));
  const commit = view => {
    for (const node of nodes(view).filter(node => node.props.ref)) {
      const name = node.props.className;
      if (!dom.has(name)) dom.set(name, { isConnected: true, blocked: false, clicks: 0,
        closest() { return this.blocked ? {} : null; },
        contains(target) { return [...dom.values()].includes(target); },
        focus() { if (this.isConnected && !this.disabled && !this.blocked) doc.activeElement = this; },
        click() { if (!this.disabled) this.clicks++; } });
      const element = dom.get(name); element.disabled = Boolean(node.props.disabled); element.props = node.props; node.props.ref.current = element;
    }
  };
  hooks.mount(module.default, initialProps, commit);
  const trigger = () => nodes(hooks.result).find(node => node.props.className === 'profile-picture-actions__trigger');
  const input = () => nodes(hooks.result).find(node => node.type === 'input');
  const group = () => nodes(hooks.result).find(node => node.props.role === 'group');
  const actions = () => group() ? nodes(group()).filter(node => node.type === 'button') : [];
  const open = () => { trigger().props.onClick(); hooks.flush(); };
  return { hooks, dom, doc, listeners, calls, changes, trigger, input, group, actions, open, initialProps };
}
const configurations = [
  { name: 'Doctor', props: { expectedUserId: 'doctor-a', avatarUrl: 'current-photo' } },
  { name: 'Staff default ownership', props: { avatarUrl: 'current-photo' } },
  { name: 'Patient default ownership', props: { avatarUrl: '' } },
];
const groupIds = new Set();
for (const { name, props } of configurations) {
  const h = await avatarHarness(props);
  check(!h.trigger().props['aria-haspopup'] && !h.trigger().props['aria-expanded'], name + ': simple collapsed disclosure');
  check(h.input().props.tabIndex === -1 && Boolean(h.input().props['aria-label']), name + ': file input is named and excluded from sequential Tab order');
  check(h.input().props.accept === 'image/jpeg,image/png,image/webp' && !h.input().props.disabled, name + ': supported files and picker availability unchanged');
  h.open();
  const id = h.group().props.id; check(!groupIds.has(id), name + ': disclosure ID is unique'); groupIds.add(id);
  check(h.trigger().props['aria-expanded'] && h.trigger().props['aria-controls'] === id, name + ': trigger controls named group');
  check(h.group().props['aria-label'] === 'Profile photo actions' && h.actions().every(action => !action.props.role && action.props.type === 'button' && action.props.tabIndex === undefined && !action.props.disabled), name + ': normal native button navigation');
  check(h.actions().length === (props.avatarUrl ? 2 : 1), name + ': Remove appears only for existing avatar');
  const event = keyEvent('Escape'); h.hooks.result.props.onKeyDown(event); h.hooks.flush();
  check(event.prevented && event.stopped && !h.group() && h.doc.activeElement === h.dom.get('profile-picture-actions__trigger'), name + ': Escape closes and immediately restores trigger focus');
  const unrelated = keyEvent('Escape'); h.hooks.result.props.onKeyDown(unrelated);
  check(!unrelated.prevented, name + ': closed disclosure leaves Escape to its parent');
  h.open(); const tab = keyEvent('Tab'); h.hooks.result.props.onKeyDown(tab);
  check(!tab.prevented, name + ': Tab is not trapped');
  h.actions()[0].props.onClick(); h.hooks.flush();
  check(!h.group() && h.dom.get('profile-picture-actions__input').clicks === 1 && h.doc.activeElement === h.dom.get('profile-picture-actions__trigger'), name + ': Choose Photo invokes picker and restores a stable focus target');
  const uploadEvent = { target: { files: [{ type: 'image/png', size: 10 }], value: 'fake-file' } };
  await h.input().props.onChange(uploadEvent); h.hooks.flush();
  check(uploadEvent.target.value === '' && h.calls[0].type === 'upload' && h.calls[0].scope.expectedUserId === (props.expectedUserId || ''), name + ': upload clears input and preserves ownership options');
  check(h.changes[0][0] === 'saved-photo' && h.changes[0][1] === 'saved-value', name + ': upload callback signature preserved');
  if (props.avatarUrl) {
    h.open(); await h.actions()[1].props.onClick(); h.hooks.flush();
    check(h.calls.at(-1).type === 'remove' && h.changes.at(-1).join() === ',', name + ': Remove preserves callback result');
  }
  h.open(); h.doc.emit('pointerdown', { target: {} }); h.hooks.flush();
  check(!h.group() && [...h.listeners.values()].every(set => set.size === 0), name + ': outside click closes and removes listener');
  h.open(); h.hooks.update({ ...h.initialProps, disabled: true });
  check(h.trigger().props.disabled && h.input().props.disabled && h.actions().every(action => action.props.disabled), name + ': loading disables trigger, picker and disclosed actions');
  h.hooks.unmount(); check([...h.listeners.values()].every(set => set.size === 0), name + ': unmount cleans outside listener');
}
for (const blocked of ['removed', 'inert']) {
  const h = await avatarHarness(); h.open(); const trigger = h.dom.get('profile-picture-actions__trigger');
  if (blocked === 'removed') trigger.isConnected = false; else trigger.blocked = true;
  h.doc.activeElement = null; h.hooks.result.props.onKeyDown(keyEvent('Escape')); h.hooks.flush();
  check(h.doc.activeElement === null && !h.group(), 'Escape safely skips ' + blocked + ' trigger'); h.hooks.unmount();
}
for (const abandon of ['replacement', 'unmount']) {
  const gate = deferred(), h = await avatarHarness({ expectedUserId: 'doctor-a' }, { upload: () => gate.promise });
  const event = () => ({ target: { files: [{ type: 'image/png', size: 10 }], value: 'fake' } });
  const pending = h.input().props.onChange(event()); await h.input().props.onChange(event()); h.hooks.flush();
  check(h.calls.length === 1 && h.trigger().props.disabled && h.trigger().props['aria-busy'] && h.input().props.disabled, abandon + ': duplicate lock and busy UI preserved');
  check(h.calls[0].scope.isCurrent(), abandon + ': initiating owner remains bound');
  if (abandon === 'replacement') h.hooks.update({ ...h.initialProps, expectedUserId: 'doctor-b' }); else h.hooks.unmount();
  check(h.calls[0].scope.signal.aborted && !h.calls[0].scope.isCurrent(), abandon + ': pending scope aborted and old identity invalidated');
  gate.resolve({ displayUrl: 'old-photo', storedValue: 'old-value' }); await pending; h.hooks.flush();
  check(h.changes.length === 0, abandon + ': late completion cannot update parent');
  if (abandon === 'replacement') h.hooks.unmount();
}
{
  const h = await avatarHarness({}, { upload: async () => { throw Error('Synthetic invalid photo'); } });
  await h.input().props.onChange({ target: { files: [{}], value: 'fake' } }); h.hooks.flush();
  check(nodes(h.hooks.result).some(node => node.props.role === 'alert' && node.props.children === 'Synthetic invalid photo'), 'Validation failure remains announced');
  check(!h.trigger().props.disabled && !h.input().props.disabled, 'Failed avatar operation releases busy UI'); h.hooks.unmount();
}
async function consumers(path = 'src') {
  const matches = [];
  for (const entry of await readdir(new URL(path + '/', root), { withFileTypes: true })) {
    const next = path + '/' + entry.name;
    if (entry.isDirectory()) matches.push(...await consumers(next));
    else if (entry.name.endsWith('.jsx') && (await source(next)).includes('<ProfilePictureActions')) matches.push(next);
  }
  return matches.sort();
}
const expected = ['src/pages/doctor/Doctor_ViewProfile.jsx', 'src/pages/patient/Patient_PWA_ViewProfile.jsx', 'src/pages/staff/Staff_ViewProfile.jsx'];
check(JSON.stringify(await consumers()) === JSON.stringify(expected), 'Every shared avatar consumer is accounted for');
for (const path of expected) {
  const page = await source(path), block = page.slice(page.indexOf('<ProfilePictureActions'), page.indexOf('/>', page.indexOf('<ProfilePictureActions')) + 2);
  check(block.includes('avatarUrl=') && block.includes('disabled=') && block.includes('onChange='), path + ': public avatar contract preserved');
  if (path.includes('/doctor/')) check(block.includes('key={profile.id}') && block.includes('expectedUserId={profile.id}'), 'Doctor avatar keeps identity key and explicit initiating user');
}
console.log('Doctor Profile tabs/avatar accessibility verification passed: ' + checks + ' assertions.');
console.log('Actual JSX and handlers exercised with synthetic React/DOM and mocked avatar helpers; consumers/CSS checked from source. Native keyboard/file-picker and screen-reader behavior still need browser verification.');
