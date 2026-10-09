// Production hooks/JSX executed with synthetic auth, DOM and clocks; no live access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import * as vm from 'node:vm';
import { transformWithOxc } from 'vite';
import { getDoctorRouteAuthorization } from '../src/lib/doctorRouteAuthorization.js';

if (!vm.SourceTextModule) {
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
const root = new URL('../', import.meta.url);
const source = path => readFile(new URL(path, root), 'utf8');
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async hooks => { for (let i = 0; i < 30; i++) await Promise.resolve(); hooks?.flush(); };
function events() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, event) { for (const fn of [...(listeners.get(name) || [])]) fn(event); } };
}
function hooksRuntime() {
  const slots = []; const effects = []; let index = 0; let dirty; let component; let props; let result; let commit;
  let stateWrites = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const runtime = {
    useRef(value) { const i = index++; return slots[i] ||= { current: value }; },
    useState(value) { const i = index++; slots[i] ||= { value: typeof value === 'function' ? value() : value }; return [slots[i].value, next => { stateWrites++; const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useCallback(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
    useMemo(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    useId() { const i = index++; slots[i] ||= { value: 'synthetic-disclosure-' + i }; return slots[i].value; },
  };
  return { runtime, get result() { return result; }, get stateWrites() { return stateWrites; },
    mount(fn, initial = {}, onCommit) { component = fn; props = initial; commit = onCommit; dirty = true; this.flush(); },
    flush() { let count = 0; while (dirty) { if (++count > 30) throw Error('render loop'); dirty = false; index = 0; result = component(props); commit?.(result); for (const fn of effects.splice(0)) fn(); } },
    update(next) { props = next; dirty = true; this.flush(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}
const element = (type, props) => ({ type, props: props || {} });
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
async function evaluate(code, identifier, mocks, context) {
  if (identifier.endsWith('.jsx')) code = (await transformWithOxc(code, identifier, { jsx: { runtime: 'automatic' } })).code;
  code = code.replace(/import.meta.env/g, '({DEV:false})');
  const module = new vm.SourceTextModule(code, { context, identifier });
  await module.link(async specifier => {
    if (specifier in mocks) {
      const values = mocks[specifier]; return new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
    }
    throw Error('Unmocked dependency: ' + specifier);
  });
  await module.evaluate(); return module.namespace;
}
const dashboard = await source('src/pages/doctor/Doctor_Dashboard.jsx');
const retrySource = await source('src/hooks/useDoctorIdentityRetry.js');
const identitySource = await source('src/hooks/useAuthenticatedDoctor.js');
const clinicStatus = await import('../src/lib/clinicAccountStatus.js');
const coordinator = dashboard.slice(dashboard.indexOf('function createDashboardRefreshCoordinator()'), dashboard.indexOf('const navItems'));
const refreshEffect = dashboard.slice(dashboard.indexOf('  useEffect(() => {\n    if (activePage !== "dashboard"'), dashboard.indexOf('  const openMedicalRecordTarget'));
async function identityHarness({ initialResult, profile, personal, professional } = {}) {
  const hooks = hooksRuntime(); const window = { ...events() }; const authListeners = new Set(); const queryCalls = []; const channels = [];
  const timeouts = new Map(), intervals = new Map(); let timer = 0; let userCalls = 0; let removed = 0;
  window.setTimeout = (fn) => { timeouts.set(++timer, fn); return timer; }; window.clearTimeout = id => timeouts.delete(id);
  window.setInterval = (fn, delay) => { check(delay === 60000, 'successful retry preserves normal polling period'); intervals.set(++timer, fn); return timer; }; window.clearInterval = id => intervals.delete(id);
  const user = { id: 'doctor-a', email: 'synthetic@example.test' };
  const client = { userResult: initialResult || { data: { user }, error: null },
    results: { profiles: profile || { data: { id: user.id, full_name: 'Synthetic', role: 'doctor', account_status: 'active' }, error: null },
      doctor_personal_information: personal || { data: null, error: null }, doctor_professional_information: professional || { data: null, error: null } },
    auth: { getUser: async () => { userCalls++; if (client.userReject) throw client.userReject; return client.userResult; },
      onAuthStateChange(fn) { authListeners.add(fn); return { data: { subscription: { unsubscribe: () => authListeners.delete(fn) } } }; } },
    from(table) { const query = { select() { return query; }, eq(column, id) { queryCalls.push({ table, column, id }); return query; }, maybeSingle: async () => client.results[table] }; return query; },
    channel(name) { const entry = { name, filters: [] }; channels.push(entry); const channel = { on(event, filter, callback) { entry.filters.push({ event, filter, callback }); return channel; }, subscribe: () => channel }; return channel; },
    removeChannel() { removed++; },
    emit(event, next) { for (const fn of [...authListeners]) fn(event, next); } };
  const context = vm.createContext({ window, console });
  const retry = await evaluate(retrySource, 'retry.js', { react: hooks.runtime }, context);
  const identity = await evaluate(identitySource, 'identity.js', { react: hooks.runtime, '../lib/supabaseClient': { supabase: client },
    '../lib/clinicAccountStatus': clinicStatus, '../lib/profilePicture': { getProfilePictureDisplayUrl: async () => '', profilePictureUpdatedEvent: 'avatar-updated' } }, context);
  const loads = [];
  const integration = await evaluate(`import {useRef,useEffect,useCallback} from 'react';\n${coordinator}\nexport function useDashboardRefresh(authenticatedDoctorId) { const activePage='dashboard'; const dashboardRefreshCoordinatorRef=useRef(null); const dashboardStatsRequestRef=useRef(0); const loadDashboardStats=useCallback(async()=>recordLoad(authenticatedDoctorId),[authenticatedDoctorId]);\n${refreshEffect}\n}`, 'integration.js', { react: hooks.runtime }, vm.createContext({ window, console, supabase: client, recordLoad: id => loads.push(id) }));
  hooks.mount(() => { const doctorIdentity = identity.useAuthenticatedDoctor(); const recovery = retry.useDoctorIdentityRetry(doctorIdentity); integration.useDashboardRefresh(doctorIdentity.authUser?.id || ''); return { doctorIdentity, ...recovery }; });
  return { hooks, client, retry, identity, user, queryCalls, channels, timeouts, intervals, loads, window, authListeners,
    get userCalls() { return userCalls; }, get removed() { return removed; }, runTimers() { for (const [id, fn] of timeouts) { timeouts.delete(id); fn(); } } };
}
const transient = { data: null, error: { message: 'Synthetic service unavailable', code: 'XX000' }, status: 503 };
const querySuccess = { data: { id: 'doctor-a', role: 'doctor', account_status: 'active' }, error: null, status: 200 };
{
  const h = await identityHarness({ profile: transient });
  check(h.hooks.result.doctorIdentity.loading && !h.hooks.result.retrying, 'initial loading is distinct from user-initiated retry');
  h.client.emit('INITIAL_SESSION', { user: h.user }); await settle(h.hooks);
  check(h.hooks.result.doctorIdentity.error.code === 'doctor_profile_query_error' && !h.hooks.result.doctorIdentity.authUser, 'initial profile query failure has no authorized Doctor identity');
  check(h.hooks.result.doctorIdentity.error.status === 503 && h.hooks.result.doctorIdentity.error.cause.code === 'XX000', 'original service status/cause retained for transient classification');
  check(h.retry.isRetryableDoctorIdentityError(h.hooks.result.doctorIdentity.error), 'service failure offers retry');
  check(h.intervals.size === 0 && h.channels.length === 0 && h.loads.length === 0, 'identity failure starts no unscoped dashboard work');
  const gate = deferred(); h.client.results.profiles = gate.promise;
  const request = h.hooks.result.retry(); const duplicate = h.hooks.result.retry();
  check(request === duplicate, 'rapid retry attempts share one in-flight promise');
  h.hooks.flush(); check(h.hooks.result.retrying, 'pending retry exposes distinct busy state'); await settle(h.hooks);
  check(h.userCalls === 1 && h.queryCalls.filter(q => q.table === 'profiles').length === 2, 'one explicit retry invokes existing authorized refresh once');
  gate.resolve(querySuccess); await request; await settle(h.hooks);
  check(h.hooks.result.doctorIdentity.authUser.id === 'doctor-a' && !h.hooks.result.doctorIdentity.error && !h.hooks.result.retrying, 'successful retry restores authorized identity and normal state');
  check(h.channels[0].name === 'doctor-dashboard-doctor-a' && h.channels[0].filters[1].filter.filter === 'doctor_id=eq.doctor-a', 'successful retry resumes real Doctor-scoped dashboard subscription');
  h.runTimers(); await settle(h.hooks);
  check(h.loads.join() === 'doctor-a' && h.intervals.size === 1, 'successful retry resumes normal initial dashboard loading and polling');
  check(h.queryCalls.every(q => q.id === 'doctor-a'), 'all identity queries retain explicit authenticated user scope');
  h.client.emit('SIGNED_OUT', null); h.hooks.flush();
  check(!h.hooks.result.doctorIdentity.authUser && h.intervals.size === 0 && h.removed === 1, 'sign-out invalidates retry-created dashboard work and subscriptions');
  h.hooks.unmount();
  check(h.authListeners.size === 0 && [...h.window.listeners.values()].every(s => s.size === 0), 'identity and refresh hooks clean up listeners on unmount');
}
{
  const h = await identityHarness({ profile: transient }); h.client.emit('INITIAL_SESSION', { user: h.user }); await settle(h.hooks);
  const request = h.hooks.result.retry(); await request; await settle(h.hooks);
  check(!h.hooks.result.retrying && !h.hooks.result.doctorIdentity.authUser && h.retry.isRetryableDoctorIdentityError(h.hooks.result.doctorIdentity.error), 'second transient failure remains retryable and unauthorized');
  const calls = h.queryCalls.length; await settle(h.hooks); await settle(h.hooks);
  check(h.queryCalls.length === calls && h.intervals.size === 0, 'failed retry has no automatic retry loop');
  h.client.userReject = new TypeError('Failed to fetch'); await h.hooks.result.retry(); await settle(h.hooks);
  check(h.hooks.result.retryError?.message === 'Failed to fetch' && !h.hooks.result.retrying, 'rejected authorized refresh is handled without unhandled rejection');
  delete h.client.userReject; h.client.results.profiles = querySuccess; await h.hooks.result.retry(); await settle(h.hooks);
  check(h.hooks.result.doctorIdentity.authUser?.id === 'doctor-a', 'explicit retry can recover after rejected refresh'); h.hooks.unmount();
}
for (const [label, profile, code] of [
  ['missing', { data: null, error: null }, 'doctor_profile_missing'],
  ['wrong-role', { data: { id: 'doctor-a', role: 'patient', account_status: 'active' }, error: null }, 'doctor_role_mismatch'],
  ['inactive', { data: { id: 'doctor-a', role: 'doctor', account_status: 'inactive' }, error: null }, 'doctor_account_inactive'],
  ['forbidden', { data: null, error: { message: 'Network permissions unavailable', code: '42501' }, status: 403 }, 'doctor_profile_query_error'],
]) {
  const h = await identityHarness({ profile }); h.client.emit('INITIAL_SESSION', { user: h.user }); await settle(h.hooks);
  check(h.hooks.result.doctorIdentity.error?.code === code && !h.hooks.result.doctorIdentity.authUser, 'identity blocks ' + label);
  check(!h.retry.isRetryableDoctorIdentityError(h.hooks.result.doctorIdentity.error), 'no transient retry offered for ' + label);
  check(h.hooks.result.retry() === undefined && h.userCalls === 0 && h.channels.length === 0, 'retry cannot bypass ' + label);
  check(!getDoctorRouteAuthorization({ user: h.user, profile: profile.data, profileError: profile.error }).authorized, 'parent authorization still denies ' + label);
  h.hooks.unmount();
}
for (const stage of ['doctor_personal_information', 'doctor_professional_information']) {
  const h = await identityHarness(); h.client.results[stage] = transient; h.client.emit('INITIAL_SESSION', { user: h.user }); await settle(h.hooks);
  check(h.retry.isRetryableDoctorIdentityError(h.hooks.result.doctorIdentity.error) && h.hooks.result.doctorIdentity.error.status === 503, 'transient error metadata survives ' + stage);
  h.client.results[stage] = { data: null, error: null }; await h.hooks.result.retry(); await settle(h.hooks);
  check(h.hooks.result.doctorIdentity.authUser?.id === 'doctor-a', 'authorized retry recovers ' + stage); h.hooks.unmount();
}
for (const abandon of ['sign-out-during-getUser', 'replacement-during-query', 'unmount-during-query', 'unmount-before-request']) {
  const h = await identityHarness({ profile: transient }); h.client.emit('INITIAL_SESSION', { user: h.user }); await settle(h.hooks);
  const gate = deferred();
  if (abandon === 'sign-out-during-getUser') h.client.userResult = gate.promise;
  else h.client.results.profiles = gate.promise;
  const request = h.hooks.result.retry();
  if (abandon === 'unmount-before-request') h.hooks.unmount();
  else {
    await settle(h.hooks);
    if (abandon === 'sign-out-during-getUser') h.client.emit('SIGNED_OUT', null);
    else if (abandon === 'replacement-during-query') {
      h.client.results.profiles = { data: { id: 'doctor-b', role: 'doctor', account_status: 'active' }, error: null };
      h.client.emit('SIGNED_IN', { user: { id: 'doctor-b' } }); await settle(h.hooks);
    } else h.hooks.unmount();
  }
  const beforeWrites = h.hooks.stateWrites; const beforeQueries = h.queryCalls.length;
  gate.resolve(abandon === 'sign-out-during-getUser' ? { data: { user: h.user }, error: null } : querySuccess);
  await request; await settle(h.hooks);
  if (abandon.startsWith('unmount')) check(h.hooks.stateWrites === beforeWrites, 'late retry cannot write state after ' + abandon);
  else check(h.hooks.result.doctorIdentity.authUser?.id !== 'doctor-a', 'late retry cannot restore old Doctor after ' + abandon);
  if (abandon === 'sign-out-during-getUser') check(h.queryCalls.length === beforeQueries && h.channels.length === 0, 'signed-out getUser result cannot start authorization queries');
  if (abandon === 'unmount-before-request') check(h.userCalls === 0, 'unmounted queued retry never calls refresh');
  if (!abandon.startsWith('unmount')) h.hooks.unmount();
}
const classifierHooks = hooksRuntime(); const context = vm.createContext({ console });
const retryModule = await evaluate(retrySource, 'classifier.js', { react: classifierHooks.runtime }, context);
for (const error of [null, {code:'doctor_not_authenticated'}, {code:'doctor_role_mismatch'}, {code:'doctor_profile_missing'}, {code:'doctor_account_inactive'}, {code:'unexpected',message:'network'}, {code:'doctor_auth_error',cause:{status:401,message:'network'}}, {code:'doctor_profile_query_error',cause:{status:403,message:'timeout'}}, {code:'doctor_profile_query_error',cause:{code:'PGRST301',message:'network'}}, {code:'doctor_profile_query_error',cause:{code:'42703',message:'column missing'}}, {code:'doctor_profile_query_error',cause:{status:400,message:'invalid query'}}]) check(!retryModule.isRetryableDoctorIdentityError(error), 'classifier refuses absent/authorization/schema/query errors: ' + JSON.stringify(error));
for (const error of [{message:'Failed to fetch'}, {code:'doctor_auth_error',cause:{status:0}}, {code:'doctor_profile_query_error',cause:{status:504}}, {code:'doctor_profile_query_error',cause:{code:'08006'}}, {code:'doctor_professional_query_error',cause:{code:'57014'}}, {code:'doctor_personal_query_error',cause:{message:'connection timed out'}}]) check(retryModule.isRetryableDoctorIdentityError(error), 'classifier recognizes transport/service failures: ' + JSON.stringify(error));

// Execute the real profile disclosure and identity recovery JSX/callbacks.
const profileSource = dashboard.slice(dashboard.indexOf('function ProfileDropdown('), dashboard.indexOf('function DashboardHome('));
async function profileHarness(focusRequestRef = {current:false}, suppliedLogout) {
  const hooks = hooksRuntime(); const document = { ...events(), activeElement: null }; const window = events(); const navigations = []; let focus = 0; let logoutCalls = 0;
  const props = { profile: { displayName:'Synthetic Doctor',roleLabel:'Doctor',avatarUrl:'' }, focusRequestRef,
    setActivePage: page => navigations.push(page), onLogout: suppliedLogout || (()=>logoutCalls++) };
  const module = await evaluate(`import {useId,useRef,useState,useEffect} from 'react';\nconst Icon='Icon';const ProfileAvatarContent='ProfileAvatarContent';const getInitials=()=> 'SD';\n${profileSource}\nexport {ProfileCard,ProfileDropdown,DoctorIdentityRecovery};`, 'profile.jsx', {react:hooks.runtime,'react/jsx-runtime':jsx}, vm.createContext({ document, window, isRetryableDoctorIdentityError: retryModule.isRetryableDoctorIdentityError }));
  const commit = tree => { for (const node of nodes(tree)) if (node.props?.ref && !node.props.ref.current) node.props.ref.current = { contains: target => Boolean(target?.inside), focus() { focus++; document.activeElement=this; } }; };
  hooks.mount(module.ProfileCard,props,commit);
  return { hooks, module, document, window, navigations, props, get focus(){return focus;}, get logoutCalls(){return logoutCalls;},
    trigger:()=>nodes(hooks.result).find(n=>n.type==='button'), dropdown:()=>nodes(hooks.result).find(n=>n.type===module.ProfileDropdown),
    open(){this.trigger().props.onClick();hooks.flush();}, actions(){return nodes(module.ProfileDropdown(this.dropdown().props)).filter(n=>n.type==='button');} };
}
{
  const h = await profileHarness(); const trigger = h.trigger();
  check(trigger.props.type === 'button' && !trigger.props['aria-expanded'], 'native disclosure button supports standard Enter/Space activation');
  h.open(); check(h.trigger().props['aria-expanded'] && h.trigger().props['aria-controls'] === h.dropdown().props.id, 'trigger opens disclosure and identifies its controlled panel');
  const panel = h.module.ProfileDropdown(h.dropdown().props);
  check(panel.props.role === 'group' && panel.props['aria-label'] === 'Doctor account actions', 'profile uses labeled disclosure group');
  check(nodes(panel).every(n=>!['menu','menuitem'].includes(n.props.role)) && !h.trigger().props['aria-haspopup'], 'disclosure has no incomplete menu roles');
  const actions = h.actions(); check(actions.length===3 && actions.every(n=>n.props.type==='button' && n.props.tabIndex===undefined), 'all three native action buttons remain in normal Tab order');
  let prevented=0;
  for (const key of ['Tab','ArrowDown','ArrowUp','Home','End']) h.document.emit('keydown',{key,preventDefault(){prevented++;}});
  h.hooks.flush(); check(prevented===0 && Boolean(h.dropdown()), 'disclosure leaves Tab and arrow navigation to native browser behavior');
  h.hooks.result.props.onBlur({currentTarget:{contains:t=>Boolean(t?.inside)},relatedTarget:{inside:true}}); h.hooks.flush();
  check(Boolean(h.dropdown()), 'moving focus among disclosure actions keeps it open');
  h.document.emit('keydown',{key:'Escape',preventDefault(){prevented++;}}); h.hooks.flush();
  check(!h.dropdown() && h.focus===1 && prevented===1, 'Escape closes and restores trigger focus');
  h.open(); h.open(); check(!h.dropdown(), 'second native activation closes the disclosure');
  h.open(); h.document.emit('pointerdown',{target:{inside:true}}); h.hooks.flush(); check(Boolean(h.dropdown()), 'inside touch/pointer activation keeps panel open');
  h.document.emit('pointerdown',{target:{inside:false}}); h.hooks.flush(); check(!h.dropdown(), 'outside pointer activation closes on mouse and touch');
  h.open(); h.hooks.result.props.onBlur({currentTarget:{contains:()=>false},relatedTarget:null}); h.hooks.flush(); check(!h.dropdown(), 'Tab focus leaving the disclosure closes it');
  for (const [ordinal, page] of [[0,'profile'],[1,'settings']]) {
    h.open(); const before=h.focus; h.actions()[ordinal].props.onClick(); h.hooks.flush();
    check(h.navigations.at(-1)===page && !h.dropdown() && h.focus===before+1, 'action closes and restores focus before navigation: '+page);
  }
  h.open(); h.actions()[2].props.onClick(); h.hooks.flush(); check(h.logoutCalls===1 && !h.dropdown(), 'Log out closes disclosure and invokes shared logout controller');
  h.open(); h.window.emit('doctor:close-profile-menu'); h.hooks.flush(); check(!h.dropdown(), 'existing close-profile integration remains supported');
  h.open(); h.hooks.unmount(); check([...h.document.listeners.values(),...h.window.listeners.values()].every(set=>set.size===0), 'profile unmount removes all disclosure listeners');
  const focusRequest = {current:true}; const next = await profileHarness(focusRequest);
  check(next.focus===1 && !focusRequest.current, 'navigation remount consumes one focus request on the new trigger'); next.hooks.unmount();
  for (const [error,retrying,retryable] of [[{code:'doctor_profile_query_error',cause:transient.error,status:503},false,true],[{code:'doctor_role_mismatch'},false,false],[null,true,true]]) {
    let attempts=0; const recovery=h.module.DoctorIdentityRecovery({error,retrying,onRetry:()=>attempts++}); const button=nodes(recovery).find(n=>n.type==='button'); const message=nodes(recovery).find(n=>n.type==='p');
    check(Boolean(button)===retryable && message.props.role===(retrying?'status':'alert'), 'recovery semantics distinguish service/access/retrying state');
    if(button)check(button.props.disabled===retrying && recovery.props['aria-busy']===(retrying||undefined), 'recovery button busy/disabled state is explicit');
    if(button&&!retrying){button.props.onClick();check(attempts===1,'recovery action invokes supplied authorized retry');}
  }
}
// The wrapper requests focus for canonical route remounts, including same-page
// query/legacy URLs, while same-URL navigation keeps the existing trigger.
{
  const hooks=hooksRuntime();const focusRequest={current:false};const navigations=[];
  const callback=dashboard.slice(dashboard.indexOf('  const navigateProfilePage'),dashboard.indexOf('  useEffect(() => {',dashboard.indexOf('  const navigateProfilePage')));
  const module=await evaluate(`import {useCallback} from 'react';export function useProfileNavigation({activePage,location}){const profileNavigationFocusRef=focusRequest;\n${callback}return navigateProfilePage;}`,'focus-navigation.js',{react:hooks.runtime},vm.createContext({focusRequest,navigateDoctorPage:page=>navigations.push(page),doctorPagePaths:{profile:'/doctor/profile',settings:'/doctor/settings'}}));
  for(const [activePage,pathname,search,destination,requested] of [['dashboard','/doctor/dashboard','','profile',true],['profile','/doctor/profile','','profile',false],['profile','/doctor/profile','?legacy=1','profile',true],['profile','/doctor','?section=profile','profile',true],['profile','/doctor/profile','','settings',true]]){
    hooks.mount(module.useProfileNavigation,{activePage,location:{pathname,search}});hooks.result(destination);
    check(focusRequest.current===requested && navigations.at(-1)===destination,'profile navigation focus survives remount/canonical URL: '+pathname+search+' -> '+destination);
  }
  hooks.unmount();
}
// Execute both real entry callbacks with the same controller; provider recovery is
// covered by verify-role-inactivity.mjs, rather than a duplicated logout engine.
{
  const window = events(); const hooks = hooksRuntime(); let signOuts=0; const navigations=[]; const targets=[]; const requestDoctorSignOut=()=>{signOuts++;};
  const effect = dashboard.slice(dashboard.lastIndexOf('  useEffect(() => {',dashboard.indexOf('    const handleDoctorNavigation')),dashboard.indexOf('  const renderContent'));
  const listener = await evaluate(`import {useEffect} from 'react';export function NavigationListener(){${effect}return null;}`, 'navigation.js', {react:hooks.runtime}, vm.createContext({window,requestDoctorSignOut,navigateDoctorPage:page=>navigations.push(page),openMedicalRecordTarget:target=>targets.push(target)}));
  hooks.mount(listener.NavigationListener);
  const profile=await profileHarness({current:false},requestDoctorSignOut); profile.open(); profile.actions()[2].props.onClick();
  window.emit('doctor:navigate',{detail:{section:'logout'}});
  check(signOuts===2 && navigations.length===0, 'Profile and doctor:navigate logout delegate to the same session controller without unconditional Login navigation');
  window.emit('doctor:navigate',{detail:{section:'settings'}}); window.emit('doctor:navigate',{detail:{section:'medicalRecords',medicalRecordTarget:{patientId:'patient-a'}}});
  check(navigations.join()==='settings' && targets[0].patientId==='patient-a', 'other navigation event actions preserve existing routing');
  hooks.unmount(); profile.hooks.unmount(); check(window.listeners.get('doctor:navigate').size===0,'Dashboard navigation listener cleans up on unmount');
}
// Guard scope by comparing completed Batch 1 implementation against the baseline.
const baseline = path => {const run=spawnSync('git',['show','0601526:'+path],{encoding:'utf8',windowsHide:true}); if(run.status!==0)throw Error(run.stderr);return run.stdout;};
const previousDashboard=baseline('src/pages/doctor/Doctor_Dashboard.jsx');
for(const [start,end,label] of [['function createDashboardRefreshCoordinator()','const navItems','refresh serialization'],['function DashboardHome(','function Doctor_Dashboard()','counters and appointment/patient actions'],['  const loadDashboardStats','  const openMedicalRecordTarget','pagination/counting/loading/refresh'],['  const openMedicalRecordTarget','  const navigateProfilePage','exact patient and appointment routing']]) {
  const previousEnd=end==='  const navigateProfilePage'?'  useEffect(() => {\n    const nextTarget':end;
  const a=dashboard.slice(dashboard.indexOf(start),dashboard.indexOf(end,dashboard.indexOf(start)));
  const b=previousDashboard.slice(previousDashboard.indexOf(start),previousDashboard.indexOf(previousEnd,previousDashboard.indexOf(start)));
  check(a===b,'Batch 1 remains unchanged: '+label);
}
for(const path of ['src/lib/doctorDashboardSchedule.js','src/lib/roleInactivity.js','src/lib/doctorRouteAuthorization.js','src/App.jsx','src/styles/doctor-dashboard.css','src/components/auth/InactivityWarningDialog.jsx','src/hooks/useRoleInactivityIdentity.js']) check((await source(path)).replace(/\r\n/g,'\n')===baseline(path).replace(/\r\n/g,'\n'),'protected shared/security/layout source unchanged: '+path);
console.log('Doctor Dashboard Batch 2 verification passed: '+checks+' assertions.');
console.log('Production identity/retry hooks, profile JSX, logout/navigation callbacks and refresh integration tested with mocked auth/DOM/timers; no live/browser validation.');
