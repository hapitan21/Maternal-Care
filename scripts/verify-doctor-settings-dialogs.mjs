import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as vm from "node:vm";
import { manageDoctorSettingsDialog, rememberDoctorSettingsDialogTrigger } from "../src/hooks/useDoctorSettingsDialog.js";

if (!vm.SourceTextModule) {
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const source = async path => (await readFile(new URL("../" + path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// Deliberately synthetic DOM: run the production controller and hook, without
// claiming native browser layout, accessibility-tree or screen-reader testing.
class Element {
  constructor(doc, tag, attrs = {}) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.attrs = new Map(Object.entries(attrs));
    this.children = []; this.parentElement = null; this.style = {}; this.focusCalls = 0;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  get tabIndex() { return this.hasAttribute('tabindex') ? Number(this.attrs.get('tabindex')) : ['BUTTON','INPUT','SELECT','TEXTAREA'].includes(this.tagName) ? 0 : -1; }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  matches(selector) {
    if (selector.startsWith('.')) return this.attrs.get('class')?.split(' ').includes(selector.slice(1));
    if (selector === '[hidden], [inert]') return this.hasAttribute('hidden') || this.hasAttribute('inert');
    if (selector === ':disabled, [aria-disabled="true"]') return this.disabled || this.attrs.get('aria-disabled') === 'true' || Boolean(this.parentElement?.closest('fieldset[disabled]'));
    if (selector === 'fieldset[disabled]') return this.tagName === 'FIELDSET' && this.disabled;
    if (selector === '[data-dialog-initial-focus]') return this.hasAttribute('data-dialog-initial-focus');
    return ['BUTTON','INPUT','SELECT','TEXTAREA','A'].includes(this.tagName) || this.hasAttribute('tabindex');
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (node.hasAttribute('hidden') || node.style.display === 'none') return [];
    return this.isConnected ? [{}] : [];
  }
  focus() {
    if (!this.isConnected || this.disabled || this.closest('[hidden], [inert]')) return;
    this.focusCalls++; this.ownerDocument.activeElement = this;
    this.ownerDocument.emit('focusin', { target: this });
  }
}
function fixture(kind) {
  const listeners = new Map(), observers = new Set();
  const doc = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, event) { for (const fn of [...(listeners.get(name) || [])]) fn(event); },
    mutate() { for (const observer of observers) observer.callback(); },
    defaultView: {
      getComputedStyle(element) { return { visibility: element.style.visibility || 'visible' }; },
      MutationObserver: class {
        constructor(callback) { this.callback = callback; }
        observe() { observers.add(this); }
        disconnect() { observers.delete(this); }
      },
    },
  };
  const make = (parent, tag, attrs) => parent.append(new Element(doc, tag, attrs));
  const body = doc.body = new Element(doc, 'body');
  const provider = make(body, 'div');
  const root = make(provider, 'div', { class: 'doctor-dashboard' });
  const sidebar = make(root, 'nav');
  const main = make(root, 'main');
  const profile = make(main, 'div', { class: 'doctor-global-profile-slot' });
  const profileButton = make(profile, 'button');
  const settings = make(main, 'section', { class: 'doctor-settings-page' });
  const header = make(settings, 'header');
  const trigger = make(header, 'button');
  const form = make(settings, 'form');
  const field = make(form, 'input');
  const overlay = make(settings, 'div');
  const dialog = make(overlay, kind === 'schedule' ? 'form' : 'section', { tabindex: '-1' });
  const closeButton = make(dialog, 'button');
  const input = make(dialog, kind === 'schedule' ? 'select' : 'input', { 'data-dialog-initial-focus': '' });
  const save = make(dialog, 'button');
  const cancel = make(dialog, 'button');
  const warning = make(body, 'section', { class: 'inactivity-dialog' });
  const stayLoggedIn = make(warning, 'button');
  doc.activeElement = trigger;
  const key = (value, shiftKey = false) => {
    const event = { key: value, shiftKey, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    doc.emit('keydown', event); return event;
  };
  return { doc, listeners, observers, make, root, provider, sidebar, profile, profileButton,
    settings, header, trigger, form, field, overlay, dialog, closeButton, input, save, cancel, warning, stayLoggedIn, key };
}
const settingsSource = await source('src/pages/doctor/Doctor_Settings.jsx');
function productionClose(kind, state, operationRef, done) {
  const name = { email: 'closeChangeEmailModal', password: 'closeChangePasswordOtpModal', schedule: 'closeScheduleEditor' }[kind];
  const start = settingsSource.indexOf('  const ' + name + ' = () => {');
  check(start >= 0, kind + ': production guarded close exists');
  const body = settingsSource.slice(start, settingsSource.indexOf('\n  };', start) + 5);
  return new Function('changeEmailState', 'changePasswordOtp', 'operationRef', 'emailFlowRef', 'passwordFlowRef',
    'setChangeEmailState', 'setChangePasswordOtp', 'setScheduleDraft', 'CHANGE_EMAIL_INITIAL_STATE', 'CHANGE_PASSWORD_INITIAL_STATE',
    body.replace(/\bisSaving\b/g, 'changeEmailState.isLoading') + '; return ' + name)(state, state, operationRef, { current: {} }, { current: {} }, done, done, done, {}, {});
}
for (const kind of ['email', 'password', 'schedule']) {
  const f = fixture(kind), state = { isLoading: false }, operation = { current: null };
  let closed = 0;
  const close = productionClose(kind, state, operation, () => { closed++; });
  const cleanup = manageDoctorSettingsDialog(f.dialog, close, f.trigger);
  check(f.doc.activeElement === f.input, kind + ': appropriate initial focus');
  check(f.profile.hasAttribute('inert') && f.header.hasAttribute('inert') && f.form.hasAttribute('inert') && f.sidebar.hasAttribute('inert'), kind + ': background controls inert');
  check(!f.overlay.hasAttribute('inert') && !f.warning.hasAttribute('inert'), kind + ': dialog and clinic warning remain available');
  f.cancel.focus(); check(f.key('Tab').prevented && f.doc.activeElement === f.closeButton, kind + ': forward wrap');
  check(f.key('Tab', true).prevented && f.doc.activeElement === f.cancel, kind + ': backward wrap');
  f.closeButton.focus(); f.key('Tab'); check(f.doc.activeElement === f.input, kind + ': normal forward navigation');
  f.key('Tab', true); check(f.doc.activeElement === f.closeButton, kind + ': normal backward navigation');
  f.input.disabled = true; f.save.setAttribute('hidden', ''); f.closeButton.focus(); f.key('Tab');
  check(f.doc.activeElement === f.cancel, kind + ': disabled and hidden controls omitted');
  f.closeButton.disabled = true; f.cancel.disabled = true; f.doc.mutate();
  check(f.doc.activeElement === f.dialog, kind + ': all-disabled fallback is safe');
  f.key('Tab'); f.key('Tab', true); check(f.doc.activeElement === f.dialog, kind + ': fallback contains both Tab directions');
  state.isLoading = true;
  f.key('Escape'); check(closed === 0, kind + ': busy state independently prevents Escape close');
  operation.current = {};
  check(f.key('Escape').prevented && closed === 0, kind + ': busy Escape invokes guard without closing');
  state.isLoading = false; f.key('Escape'); check(closed === 0, kind + ': synchronous operation lock prevents close');
  operation.current = { timedOut: true }; f.key('Escape');
  check(closed === (kind === 'schedule' ? 0 : 1), kind + ': existing timed-out close policy preserved');
  operation.current = null; f.key('Escape'); check(closed === (kind === 'schedule' ? 1 : 2), kind + ': idle Escape closes');
  const newControl = f.make(f.settings, 'button'); f.doc.mutate();
  check(newControl.hasAttribute('inert'), kind + ': newly inserted background node blocked');
  f.doc.activeElement = f.profileButton; f.doc.emit('focusin', { target: f.profileButton });
  check(f.doc.activeElement === f.dialog, kind + ': escaped/programmatic background focus recaptured');
  const scroll = { target: f.overlay, prevented: false, preventDefault() { this.prevented = true; } };
  f.doc.emit('wheel', scroll); check(scroll.prevented, kind + ': backdrop does not scroll background');
  scroll.target = f.input; scroll.prevented = false; f.doc.emit('wheel', scroll);
  check(!scroll.prevented, kind + ': dialog scroll remains available');
  f.provider.setAttribute('inert', ''); f.stayLoggedIn.focus();
  check(!f.key('Tab').prevented && !f.key('Escape').prevented && f.doc.activeElement === f.stayLoggedIn, kind + ': inactivity provider has keyboard priority');
  f.provider.removeAttribute('inert');
  cleanup();
  check(f.doc.activeElement === f.trigger, kind + ': original trigger restored');
  check([...f.listeners.values()].every(set => set.size === 0) && f.observers.size === 0, kind + ': listeners and observer cleaned');
  check(!f.profile.hasAttribute('inert') && !newControl.hasAttribute('inert'), kind + ': background blocking cleaned');
  f.trigger.focus();
  const secondCleanup = manageDoctorSettingsDialog(f.dialog, close, f.trigger);
  const nextInput = f.make(f.dialog, 'input', { 'data-dialog-initial-focus': '' });
  nextInput.focus(); nextInput.remove();
  const replacementInput = f.make(f.dialog, 'input', { 'data-dialog-initial-focus': '' }); f.doc.mutate();
  check(f.doc.activeElement === replacementInput, kind + ': removed step control moves focus into the new step');
  f.trigger.remove(); secondCleanup(); check(f.doc.activeElement !== f.trigger, kind + ': removed trigger is not focused');
}
{
  const f = fixture('email'); f.sidebar.setAttribute('inert', '');
  const cleanup = manageDoctorSettingsDialog(f.dialog, () => {}, f.trigger);
  f.provider.setAttribute('hidden', ''); cleanup();
  check(f.sidebar.hasAttribute('inert'), 'Pre-existing inert state preserved');
  check(f.doc.activeElement !== f.trigger, 'Hidden/blocked trigger is not restored');
}
{
  const f = fixture('password'), ref = { current: null };
  rememberDoctorSettingsDialogTrigger(ref, { currentTarget: f.trigger });
  check(ref.current === f.trigger, 'Click captures trigger before asynchronous Auth lookup');
  f.field.focus(); rememberDoctorSettingsDialogTrigger(ref, { currentTarget: f.form });
  check(ref.current === f.field, 'Keyboard form submission captures original focused input');
}
// Exercise actual hook re-renders: callback changes must not restart focus or
// lose updated busy guards. Reuse the existing deterministic React harness.
const regression = await source('scripts/verify-role-inactivity.mjs');
const begin = regression.indexOf('function hookRuntime()'), end = regression.indexOf('const element', begin);
const hookRuntime = new Function(regression.slice(begin, end) + ';return hookRuntime;')();
const hooks = hookRuntime(), ctx = vm.createContext({});
const module = new vm.SourceTextModule(await source('src/hooks/useDoctorSettingsDialog.js'), { context: ctx });
await module.link(() => new vm.SyntheticModule(['useEffect', 'useRef'], function() {
  this.setExport('useEffect', hooks.runtime.useEffect); this.setExport('useRef', hooks.runtime.useRef);
}, { context: ctx }));
await module.evaluate();
{
  const f = fixture('email'), triggerRef = { current: f.trigger }; let oldClose = 0, latestClose = 0;
  const Component = props => {
    const ref = module.namespace.useDoctorSettingsDialog(props.open, props.close, triggerRef);
    ref.current = f.dialog; // Synthetic DOM commit before effects flush.
    return ref;
  };
  hooks.mount(Component, { open: true, close: () => { oldClose++; } });
  f.save.focus(); const focusCalls = f.input.focusCalls;
  hooks.update({ open: true, close: () => { latestClose++; } });
  check(f.doc.activeElement === f.save && f.input.focusCalls === focusCalls, 'Normal re-render does not reset focus');
  f.key('Escape'); check(oldClose === 0 && latestClose === 1, 'Escape calls newest close callback rather than stale guard');
  hooks.update({ open: false, close: () => {} });
  check(f.doc.activeElement === f.trigger && f.observers.size === 0, 'Hook close cleans and restores focus');
  hooks.update({ open: true, close: () => {} }); hooks.unmount();
  check(f.doc.activeElement === f.trigger && [...f.listeners.values()].every(set => set.size === 0), 'Hook unmount cleans and restores focus');
}
for (const [id, ref] of [['doctor-change-email-title','emailDialogRef'], ['doctor-change-password-title','passwordDialogRef']]) {
  check(settingsSource.includes('aria-labelledby="' + id + '"\n            ref={' + ref + '}\n            tabIndex={-1}'), id + ': labelled focusable dialog wiring');
}
check(settingsSource.includes('ref={scheduleDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="doctor-schedule-edit-title"'), 'Schedule form is the labelled modal dialog');
check((settingsSource.match(/role="dialog"/g) || []).length === 3 && (settingsSource.match(/aria-modal="true"/g) || []).length === 3, 'All three dialogs retain modal semantics');
check((settingsSource.match(/doctor-otp-modal-message is-error" role="alert" aria-atomic="true"/g) || []).length === 2, 'Both credential dialogs announce errors');
check((settingsSource.match(/doctor-otp-modal-message is-success" role="status" aria-atomic="true"/g) || []).length === 2, 'Both credential dialogs announce success');
check(settingsSource.includes('id="doctor-schedule-error"\n                className="doctor-settings-field-error"\n                role="alert"'), 'Schedule validation/errors remain announced');
check((settingsSource.match(/if \(event.target === event.currentTarget\)/g) || []).length === 2, 'Existing credential backdrop close policy retained');
check((settingsSource.match(/onClick={closeScheduleEditor}/g) || []).length === 2, 'Schedule Close and Cancel share the unchanged guarded close policy');
const css = await source('src/styles/doctor-settings.css');
for (const selector of ['.doctor-settings-page .doctor-otp-modal-backdrop', '.doctor-settings-edit-overlay']) {
  const rule = css.slice(css.indexOf(selector + ' {')).split('}')[0];
  check(rule.includes('position: fixed;') && rule.includes('inset: 0;') && rule.includes('z-index: 60000;'), selector + ': full viewport above profile controls');
}
const dashboardCss = await source('src/styles/doctor-dashboard.css');
check(dashboardCss.includes('z-index: 50000 !important;') && dashboardCss.includes('z-index: 50010;'), 'Confirmed global profile controls layering source');
const inactivityCss = await source('src/styles/inactivity-warning.css');
check(inactivityCss.includes('z-index: 2147483647;'), 'Clinic inactivity warning remains above Settings dialogs');
console.log('Doctor Settings dialog accessibility verification passed: ' + checks + ' assertions.');
console.log('Production controller/hook and close guards exercised with synthetic DOM/React; semantics and layering checked from source. No live browser or Supabase verification.');
