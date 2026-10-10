/* global process */
// Actual Doctor page components/CSS in offline Chrome. No production records.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import postcss from 'postcss';

const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/');
const reminderVerifier = await readFile(join(root, 'scripts/verify-reminder-ui.js'), 'utf8');
const reminderMock = reminderVerifier.match(/const mock = `([\s\S]*?)`;\r?\n/)?.[1];
assert.ok(reminderMock, 'Reuse the existing synthetic reminder backend contract');
const mock = reminderMock.replace("patient_name: 'Synthetic Patient'", "patient_name: 'LongPatientName'.repeat(35),maternal_appointment_id:'LONG-ID-'.repeat(25)")
  .replace("const schedules =", "export const schedules =")
  .replace("maybeSingle() {return this}", "single() {return this},range() {return this},maybeSingle() {return this}")
  .replace("removeChannel(channel){channel.active=false}", "removeChannel(channel){channel.active=false;return Promise.resolve('ok')}")
  .replace("if(name==='get_doctor_patient_directory')", "if(name==='get_operational_appointment_policy')return Promise.resolve({data:{timezone:'Asia/Manila',clinic_opening_time:'08:00',clinic_closing_time:'17:00',default_appointment_duration_minutes:30},error:null});\n  if(name==='get_doctor_patient_directory')");
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {_api} from '@iconify/react';
import '${root}/src/index.css';
import '${root}/src/styles/doctor-dashboard.css';
import {DoctorAppointmentsContent} from '${root}/src/pages/doctor/Doctor_Appointments.jsx';
import Reminder from '${root}/src/pages/doctor/Doctor_Reminder.jsx';
import {DoctorPatientsContent} from '${root}/src/pages/doctor/Doctor_Patients.jsx';
import {MedicalRecordEntry} from '${root}/src/pages/doctor/Doctor_Medical_Records.jsx';
import InactivityWarningDialog from '${root}/src/components/auth/InactivityWarningDialog.jsx';
import {manageDoctorModuleDialog} from '${root}/src/hooks/useDoctorModuleDialog.js';
import {state,schedules,patientId} from 'responsive-modules-mock';
_api.setFetch(async()=>({status:404}));
const NativeDate=Date;Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-07T02:00:00Z']))}static now(){return NativeDate.parse('2026-10-07T02:00:00Z')}};
const identity={authUser:{id:patientId,email:'synthetic@example.test'},doctorDisplayName:'Synthetic Doctor',loading:false,
 userProfile:{id:patientId,full_name:'Synthetic Doctor',role:'Doctor',status:'active'}};
const harness={state,schedules,manageDoctorModuleDialog,backgroundClicks:0,errors:[]};window.responsiveTest=harness;
window.addEventListener('error',event=>harness.errors.push(event.error?.stack||event.message));
window.addEventListener('unhandledrejection',event=>harness.errors.push(String(event.reason?.stack||event.reason)));
const placeholder=<span className='doctor-global-profile-placeholder' aria-hidden='true'/>;
const long='UnbrokenClinicalFinding'.repeat(80);
const record={id:'offline-record',detailAppointmentDate:'October 9, 2026',detailAppointmentDay:'Friday',detailAppointmentTime:'8:30 AM',
 visitType:'Prenatal',gestationalAge:12,doctor:'Synthetic Doctor',updatedDate:'October 7, 2026',recordStatus:'Completed',
 complaint:long,assessment:[long],findings:[['Finding',long,'']],treatment:[long],obstetric:[],
 actionsTaken:[],pregnancyMilestones:[],vaccinations:[],prescriptions:[],diagnosticResults:[],
 recommendations:[long],procedures:[],vitals:{},diagnosis:long,followUp:'',attachment:null};
function Shell(){const [page,setPage]=useState('appointments'),[warning,setWarning]=useState(false);
 harness.setPage=setPage;harness.setWarning=setWarning;
 return <MemoryRouter><div className='doctor-dashboard'>
 <aside className='doctor-sidebar'><button id='test-sidebar' onClick={()=>harness.backgroundClicks++}>Dashboard</button></aside>
 <main className='doctor-main'><div className='doctor-global-profile-slot'><div className='doctor-shell-header-controls'>
 <div className='doctor-profile-wrapper'><button id='test-profile' className='doctor-profile-card' onClick={()=>harness.backgroundClicks++}>
 <span className='doctor-profile-info'><strong>Synthetic Doctor</strong><span>Doctor</span></span></button></div></div></div>
 <div className='doctor-content'><button id='test-open' onClick={()=>harness.api.open(harness.kind)}>Open fixture dialog</button>
 {page==='appointments'?<DoctorAppointmentsContent embedded doctorIdentity={identity} headerAction={placeholder}/>:
 page==='reminders'?<Reminder doctorIdentity={identity} headerAction={placeholder}/>:
 page==='patients'?<DoctorPatientsContent doctorIdentity={identity} headerAction={placeholder}/>:
 page==='medical'?<section className='medical-records-page'><div className='medical-records-content'><MedicalRecordEntry record={record}/></div></section>:
 <div className='doctor-dashboard-home doctor-dashboard-home--responsive'><header className='doctor-topbar'>
 <div className='doctor-page-title-block'><h2>Dashboard</h2><p>Monitor today's appointments, patients, and session activity.</p></div></header></div>}
 </div></main></div>{warning?<InactivityWarningDialog secondsRemaining={60} onStayLoggedIn={()=>setWarning(false)}/>:null}</MemoryRouter>;
}
createRoot(document.getElementById('root')).render(<Shell/>);
`;
const bundle = await build({ root, configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'offline-doctor-responsive-modules', enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('responsive-modules-test.jsx')) return '\0responsive-modules-test.jsx';
      if (id === 'responsive-modules-mock' || /\/supabaseClient(?:\.js)?$/.test(id)) return '\0responsive-modules-mock.js';
      if (/\/automaticAppointmentNotification(?:\.js)?$/.test(id)) return '\0responsive-notification.js';
      if (/\/(AppointmentVisitForm|SendPatientNotificationAction)(?:\.jsx)?$/.test(id)) return '\0responsive-unused.jsx';
    },
    load(id) {
      if (id === '\0responsive-modules-test.jsx') return fixture;
      if (id === '\0responsive-modules-mock.js') return mock;
      if (id === '\0responsive-notification.js') return 'export async function sendAutomaticAppointmentNotification(){return {ok:true}}';
      if (id === '\0responsive-unused.jsx') return 'export default function Unused(){return null}';
    },
    transform(source, id) {
      const path = id.replaceAll('\\', '/');
      if (path.endsWith('/Doctor_Patients.jsx')) return source + '\nexport {DoctorPatientsContent};';
      if (path.endsWith('/Doctor_Medical_Records.jsx')) return source + '\nexport {MedicalRecordEntry};';
      if (path.endsWith('/Doctor_Appointments.jsx')) {
        const marker = '  if (visitRoute) {';
        assert.ok(source.includes(marker));
        return source.replace(marker, `
  window.responsiveTest.api={page:'appointments',busy(kind,value){if(kind==='add')setIsSaving(value);else setUpdatingStatusId('appointment-0')},
   idle(){setIsSaving(false);setUpdatingStatusId('')},open(kind){
    if(kind==='add')openAddAppointment();
    else if(kind==='cancel')setCancelConfirmationSchedule(schedules[0]);
    else if(kind==='reschedule')setRescheduleSchedule(schedules[0]);
    else if(kind==='details')setSelectedCalendarSchedule(schedules[0]);
    else setNoShowConfirmationSchedule(schedules[0]);
   }};
` + marker);
      }
      if (path.endsWith('/Doctor_Reminder.jsx')) {
        const marker = '  return (\n    <section className="doctor-reminder-page';
        const normalized = source.replaceAll('\r\n', '\n');
        assert.ok(normalized.includes(marker));
        return normalized.replace(marker, `
  window.responsiveTest.api={page:'reminders',idle(){setIsSavingReminder(false);setIsSavingMedicationReminder(false);setIsSavingHealthTip(false);setIsDeletingHealthTip(false)},
   busy(kind,value){if(kind==='appointment')setIsSavingReminder(value);else if(kind==='medication')setIsSavingMedicationReminder(value);else if(kind==='health-tip')setIsSavingHealthTip(value);else setIsDeletingHealthTip(value)},
   open(kind){if(kind==='appointment')openReminderForm();else if(kind==='medication')openMedicationForm();else if(kind==='health-tip')openHealthTipForm();
    else if(kind==='delete')setDeleteHealthTipTarget({id:'synthetic-tip',title:'Synthetic tip'});else setViewAllSection(kind.replace('view-all-',''));},
   seedTip(){setHealthTips([{id:'synthetic-tip',title:'Synthetic tip',text:'Synthetic text',category:'Nutrition',databaseBacked:true,isActive:true}])}
  };
` + marker);
      }
    },
  }, react()], build: { write: false, minify: false, lib: { entry: 'responsive-modules-test.jsx', formats: ['es'] } },
});
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(value => value.output);
const code = outputs.find(value => value.type === 'chunk').code.replaceAll('</script', '<\\/script');
const css = postcss.parse(outputs.filter(value => value.type === 'asset' && value.fileName.endsWith('.css')).map(value => value.source).join('\n'));
css.walkAtRules('import', rule => rule.remove());
const temporary = await mkdtemp(join(tmpdir(), 'maternal-doctor-responsive-modules-'));
const html = join(temporary, 'fixture.html');
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${code}</script>`);
const candidates = process.env.HEADLESS_BROWSER ? [process.env.HEADLESS_BROWSER] : ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'];
let executable;
for (const path of candidates) { try { await access(path); executable = path; break; } catch { /* Try another installation. */ } }
assert.ok(executable, 'Installed Chrome/Chromium is required');
const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, 'browser-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket, cdp, assertions = 0;
const check = (condition, label) => { assert.ok(condition, label); assertions++; };
try {
  let port;
  for (let n = 0; n < 100 && !port; n++) { try { port = (await readFile(join(temporary, 'browser-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(); } }
  assert.ok(port, 'Offline browser starts');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('Browser command timeout: ' + method)); }, 5000).unref();
  });
  const evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const until = async expression => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await pause(); }
    throw new Error('Wait timed out: ' + expression + '\n' + JSON.stringify(await evaluate('window.responsiveTest?.errors')));
  };
  const key = async (value, shift = false) => {
    const windowsVirtualKeyCode = { Tab: 9, Enter: 13, Escape: 27 }[value];
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode,
      text: value === 'Enter' ? '\r' : undefined, modifiers: shift ? 8 : 0 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode, modifiers: shift ? 8 : 0 });
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector('${selector}');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const page = async name => {
    await evaluate(`window.responsiveTest.setPage('${name}')`);
    if (name === 'appointments' || name === 'reminders') await until(`window.responsiveTest.api.page==='${name}'`);
    await pause();
  };
  const testDialog = async (kind, selector, busy = true) => {
    await evaluate(`window.responsiveTest.kind='${kind}';document.querySelector('#test-open').focus()`);
    await click('#test-open'); await until(`!!document.querySelector('${selector}')`);
    await evaluate(`Promise.allSettled(document.querySelector('${selector}').getAnimations().map(a=>a.finished))`);
    check(await evaluate(`(()=>{const d=document.querySelector('${selector}');return d.getAttribute('role')==='dialog'&&d.getAttribute('aria-modal')==='true'&&!!document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim()&&d.contains(document.activeElement)})()`), kind + ': named dialog and initial focus');
    check(await evaluate(`document.querySelector('#test-profile').closest('[inert]')!==null`), kind + ': background profile inert');
    await evaluate(`document.querySelector('#test-profile').focus()`);
    check(await evaluate(`document.querySelector('${selector}').contains(document.activeElement)`), kind + ': cannot focus background');
    const controls = await evaluate(`(()=>{const d=document.querySelector('${selector}');return [...d.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(e=>!e.disabled&&e.tabIndex>=0&&e.getClientRects().length&&!e.closest('[hidden],[inert]')).length})()`);
    for (let n = 0; n < controls + 2; n++) { await key('Tab'); check(await evaluate(`document.querySelector('${selector}').contains(document.activeElement)`), kind + ': forward Tab containment'); }
    for (let n = 0; n < controls + 2; n++) { await key('Tab', true); check(await evaluate(`document.querySelector('${selector}').contains(document.activeElement)`), kind + ': reverse Tab containment'); }
    check(await evaluate(`(()=>{const d=document.querySelector('${selector}'),r=d.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1})()`), kind + ': responsive dialog bounds');
    if (busy) {
      await evaluate(`window.responsiveTest.api.busy('${kind}',true)`); await pause(); await key('Escape');
      check(await evaluate(`!!document.querySelector('${selector}')`), kind + ': busy Escape cannot close');
      await evaluate('window.responsiveTest.api.idle()'); await pause();
    }
    await key('Escape'); await until(`!document.querySelector('${selector}')`);
    check(await evaluate(`document.activeElement.id==='test-open'&&!document.querySelector('#test-profile').closest('[inert]')`), kind + ': idle Escape restores trigger and background');
    check(await evaluate('window.responsiveTest.state.writes.length===0'), kind + ': accessibility interactions do not mutate data');
  };
  await cdp('Network.enable'); await cdp('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  for (const [width, height] of [[320,568],[390,844],[768,1024],[940,900],[1024,768],[1080,900],[1171,980],[1260,900],[1440,900]]) {
    const before = assertions;
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: pathToFileURL(html).href }); await until('!!window.responsiveTest?.api');
    await until('!!document.querySelector(".doctor-appointments-row")');
    check(await evaluate(`(()=>{const row=document.querySelector('.doctor-appointments-row');return [...row.children].every(e=>e.scrollWidth<=e.clientWidth+1)&&row.scrollWidth<=row.clientWidth+1})()`), 'R2: long names and IDs stay inside fixed grid tracks');
    check(await evaluate(`(()=>{const row=document.querySelector('.doctor-appointments-row');return [...row.querySelectorAll(':scope > span')].every(e=>e.scrollHeight<=e.clientHeight+1)})()`), 'R2: long text is readable without vertical clipping');
    await evaluate("document.querySelector('.doctor-appointments-table-x-scroll').scrollLeft=99999");
    check(await evaluate(`(()=>{const b=document.querySelector('.doctor-appointment-status'),r=b.getBoundingClientRect(),s=document.querySelector('.doctor-appointments-table-x-scroll').getBoundingClientRect();return r.left>=s.left-1&&r.right<=s.right+1})()`), 'R2: status/action trigger reachable at rightmost local scroll');
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), 'R2: no page-wide horizontal overflow');
    await click('.doctor-appointment-status'); await until("!!document.querySelector('.appointment-status-popover')");
    check(await evaluate("[...document.querySelectorAll('.appointment-status-popover button')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})"), 'R2: long-name row opens reachable status/action menu');
    await key('Escape'); await until("!document.querySelector('.appointment-status-popover')");
    check(await evaluate(`(()=>{const h=document.querySelector('.doctor-appointments-header'),p=h.querySelector('.doctor-global-profile-placeholder');return getComputedStyle(p).display==='none'})()`), 'R3: appointment placeholder does not duplicate profile reservation');
    check(await evaluate(`(()=>{const t=document.querySelector('.doctor-appointments-tabs');t.scrollLeft=99999;const b=t.lastElementChild,r=b.getBoundingClientRect(),v=t.getBoundingClientRect();return getComputedStyle(t).overflowX==='auto'&&r.right<=v.right+1&&r.left>=v.left-1})()`), 'R4: final status tab reachable by local scroll');
    await evaluate("document.querySelector('.doctor-appointments-tabs').lastElementChild.focus()"); await key('Enter');
    await pause();
    check(await evaluate("document.querySelector('.doctor-appointments-tabs').lastElementChild.classList.contains('is-active')"), 'R4: keyboard tab activation preserved');
    // Return to All before opening fixture dialogs.
    await evaluate("document.querySelector('.doctor-appointments-tabs').firstElementChild.click()"); await pause();
    await testDialog('add', '.appointment-add-card');
    await testDialog('cancel', '.doctor-cancel-appointment-card');
    await testDialog('reschedule', '.doctor-appointment-reschedule-card');
    await testDialog('no-show', '.appointment-no-show-dialog');
    await testDialog('details', '.doctor-appointment-detail-modal');
    // Nested time picker Escape and the clinic warning must take precedence.
    await evaluate("window.responsiveTest.kind='add'"); await click('#test-open');
    await until("!!document.querySelector('.appointment-add-card')");
    await click('.appointment-add-card .appointment-time-picker__trigger');
    await until("!!document.querySelector('.appointment-time-picker__popover')");
    await key('Escape'); await until("!document.querySelector('.appointment-time-picker__popover')");
    check(await evaluate("!!document.querySelector('.appointment-add-card') && document.querySelector('.appointment-add-card').contains(document.activeElement)"), 'R5: nested time picker closes before parent');
    await evaluate('window.responsiveTest.setWarning(true)'); await until("!!document.querySelector('.inactivity-backdrop')");
    await key('Tab'); await key('Escape');
    check(await evaluate("document.querySelector('.inactivity-dialog').contains(document.activeElement)&&!!document.querySelector('.appointment-add-card')"), 'R5: inactivity warning keeps keyboard priority');
    await click('.inactivity-dialog button'); await until("!document.querySelector('.inactivity-backdrop')");
    await key('Escape'); await until("!document.querySelector('.appointment-add-card')");
    await page('reminders');
    await evaluate("document.querySelector('.doctor-reminder-tabs').lastElementChild.click()");
    await until("!!document.querySelector('.doctor-reminder-appointment-row')");
    check(await evaluate(`getComputedStyle(document.querySelector('.doctor-reminder-header > .doctor-global-profile-placeholder')).display==='none'`), 'R3: reminder placeholder removed only from embedded header');
    check(await evaluate(`(()=>{const h=document.querySelector('.doctor-reminder-header'),t=h.firstElementChild;return t.getBoundingClientRect().width>=h.clientWidth-parseFloat(getComputedStyle(h).paddingRight)-2})()`), 'R3: reminder description uses available header width');
    await testDialog('appointment', '.doctor-reminder-form--appointment');
    await testDialog('medication', '.doctor-medication-reminder-form');
    await testDialog('health-tip', '.doctor-health-tip-form');
    await testDialog('delete', '.doctor-health-tip-delete-dialog');
    for (const section of ['appointments','medications','healthTips']) await testDialog('view-all-' + section, '.doctor-reminder-view-all', false);
    await evaluate("window.responsiveTest.api.seedTip();window.responsiveTest.kind='view-all-healthTips'");
    await click('#test-open'); await until("!!document.querySelector('.doctor-health-tip-menu-button')");
    await click('.doctor-health-tip-menu-button'); await until("!!document.querySelector('.doctor-health-tip-action-menu')");
    check(await evaluate("!document.querySelector('.doctor-health-tip-action-menu').closest('[inert]')"), 'R5: existing owned Health Tips popup remains interactive');
    await key('Tab');
    check(await evaluate("!!document.activeElement.closest('.doctor-reminder-view-all,.doctor-health-tip-action-menu')"), 'R5: owned popup is included in focus containment');
    await key('Escape'); await until("!document.querySelector('.doctor-health-tip-action-menu')");
    check(await evaluate("!!document.querySelector('.doctor-reminder-view-all')"), 'R5: popup Escape preserves View All');
    await click('.doctor-health-tip-menu-button'); await until("!!document.querySelector('.doctor-health-tip-action-menu')");
    await click('.doctor-health-tip-action-menu button'); await until("!!document.querySelector('.doctor-health-tip-form')");
    check(await evaluate("document.querySelector('.doctor-health-tip-form input[name=title]').value==='Synthetic tip' && !document.querySelector('.doctor-reminder-view-all')"), 'R5: View All to Edit preserves existing tip draft');
    await key('Escape'); await until("!document.querySelector('.doctor-health-tip-form')");
    await page('patients'); await until("!!document.querySelector('.doctor-patients-header')");
    check(await evaluate(`getComputedStyle(document.querySelector('.doctor-patients-header > .doctor-global-profile-placeholder')).display==='none'`), 'R3: Patients phantom profile row removed');
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), 'R3: Patients stays within viewport');
    await page('dashboard');
    await until("!!document.querySelector('.doctor-dashboard-home')");
    check(await evaluate("document.querySelector('.doctor-page-title-block').getBoundingClientRect().width>100"), 'R3: Dashboard header remains readable');
    await page('medical'); await until("!!document.querySelector('.mr-medical-entry')");
    check(await evaluate(`[...document.querySelectorAll('.mr-medical-entry-content p,.mr-medical-checklist li > span,.mr-medical-findings strong')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)`), 'R6: actual complaint/findings/checklist long text wraps');
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), 'R6: clinical text causes no page overflow');
    await evaluate("document.querySelector('.doctor-dashboard').classList.add('staff-dashboard-shell')");
    check(await evaluate("getComputedStyle(document.querySelector('.mr-medical-entry-content p')).overflowWrap!=='anywhere'"), 'R6: new Doctor wrapping excludes shared Staff shell');
    await evaluate("document.querySelector('.doctor-dashboard').classList.remove('staff-dashboard-shell')");
    // Exercise removed triggers, changed controls, scroll prevention and cleanup in real DOM.
    await evaluate(`(()=>{
      const trigger=document.createElement('button');trigger.id='removed-trigger';trigger.textContent='Trigger';document.body.append(trigger);trigger.focus();
      const preserved=document.createElement('div');preserved.id='preserved-inert';preserved.inert=true;document.body.append(preserved);
      const dialog=document.createElement('section');dialog.id='dynamic-dialog';dialog.setAttribute('role','dialog');dialog.style.cssText='position:fixed;top:10px;left:10px;width:200px;background:white';
      dialog.innerHTML='<input data-dialog-initial-focus aria-label="Fixture input"><button>Cancel</button>';document.body.append(dialog);
      window.responsiveTest.cleanup=window.responsiveTest.manageDoctorModuleDialog(dialog,()=>{},trigger);
    })()`);
    check(await evaluate("document.activeElement===document.querySelector('#dynamic-dialog input')"), 'R5: explicit initial focus target');
    await evaluate("document.querySelector('#dynamic-dialog input').disabled=true"); await pause();
    check(await evaluate("document.activeElement===document.querySelector('#dynamic-dialog button')"), 'R5: disabled focused control is safely replaced');
    await evaluate("document.querySelector('#dynamic-dialog button').disabled=true"); await pause(); await key('Tab'); await key('Tab', true);
    check(await evaluate("document.activeElement.id==='dynamic-dialog'"), 'R5: all-disabled Tab fallback');
    check(await evaluate(`(()=>{const outside=new WheelEvent('wheel',{bubbles:true,cancelable:true});document.querySelector('#root').dispatchEvent(outside);const inside=new WheelEvent('wheel',{bubbles:true,cancelable:true});document.querySelector('#dynamic-dialog').dispatchEvent(inside);return outside.defaultPrevented&&!inside.defaultPrevented})()`), 'R5: background scroll blocked while dialog scrolling remains available');
    await evaluate("document.querySelector('#removed-trigger').remove();window.responsiveTest.cleanup()");
    check(await evaluate("!document.querySelector('#root').inert&&document.querySelector('#preserved-inert').inert"), 'R5: removed trigger cleanup preserves prior inert state');
    await evaluate("document.querySelector('#dynamic-dialog').remove();document.querySelector('#preserved-inert').remove()");
    check(await evaluate("window.responsiveTest.errors.length===0"), 'No fixture runtime or cleanup errors');
    console.log(`${width}x${height}: ${assertions - before} assertions passed`);
  }
  console.log(`Doctor R2-R6: ${assertions} browser assertions passed. Actual components; synthetic data/backend, external requests blocked. Fixtures: ${temporary}`);
} finally {
  if (cdp) await cdp('Browser.close').catch(() => browser.kill()); else browser.kill();
  socket?.close();
}
