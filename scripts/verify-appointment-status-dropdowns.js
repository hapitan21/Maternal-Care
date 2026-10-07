/* global process */
// Current action selectors and real page menus; offline fixtures block external traffic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import * as espree from "espree";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import * as dates from "../src/lib/appointmentDate.js";
import { getAppointmentStatusPopoverPosition } from "../src/lib/appointmentStatusPopover.js";

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const parse = source => espree.parse(source, { ecmaVersion:"latest", sourceType:"module", ecmaFeatures:{jsx:true} });
function find(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of Object.values(node)) {
    for (const item of Array.isArray(child) ? child : [child]) { const match = find(item,predicate); if (match) return match; }
  }
}
const cases = [
  { name:"Future date", status:"scheduled", start:"2026-10-08T01:00:00Z", actions:["Cancelled"] },
  { name:"Today before start", status:"scheduled", start:"2026-10-07T03:00:00Z", actions:["Check in","Cancelled"] },
  { name:"Exact start", status:"scheduled", start:"2026-10-07T02:00:00Z", actions:["Check in","Cancelled","No Show"] },
  { name:"Overdue today", status:"scheduled", start:"2026-10-07T00:00:00Z", actions:["Check in","Cancelled","No Show"] },
  { name:"Overdue previous date", status:"scheduled", start:"2026-10-06T00:00:00Z", actions:["Cancelled","No Show"] },
  { name:"Checked in", status:"checked_in", start:"2026-10-07T00:00:00Z" },
  { name:"Cancelled", status:"cancelled", start:"2026-10-07T00:00:00Z", actions:[] },
  { name:"No Show", status:"no_show", start:"2026-10-07T00:00:00Z", actions:[] },
  { name:"Completed", status:"completed", start:"2026-10-07T00:00:00Z", actions:[] },
];
let deterministic = 0;
for (const role of ["doctor","staff"]) {
  const source = await readFile(join(root,`src/pages/${role}/${role==='doctor'?'Doctor':'Staff'}_Appointments.jsx`),"utf8"), ast=parse(source);
  const declaration = name => {
    const node=find(ast,node=>node.type==='VariableDeclarator'&&node.id.name===name);
    assert.ok(node,name);return source.slice(node.start,node.end);
  };
  const functionSource = name => {const node=find(ast,node=>node.type==='FunctionDeclaration'&&node.id?.name===name);assert.ok(node,name);return source.slice(node.start,node.end)};
  const context=vm.createContext({...dates,now:'2026-10-07T02:00:00Z'});
  context.getManilaDateKey=value=>dates.getManilaDateKey(value??context.now);
  context.isAppointmentNoShowEligible=row=>dates.isAppointmentNoShowEligible(row,context.now);
  vm.runInContext(functionSource('isAppointmentToday'),context);
  if(role==='doctor'){
    vm.runInContext('const '+declaration('doctorPendingStatusActions')+';const '+declaration('doctorCheckedInStatusActions')+';',context);
  }else{
    vm.runInContext('const '+declaration('pendingStatusActions')+';const '+declaration('checkedInActions')+';'+functionSource('getDisplayStatus')+functionSource('isCheckedInStatus'),context);
  }
  const selector = role==='doctor'
    ? source.slice(find(ast,node=>node.type==='VariableDeclarator'&&node.id.name==='availableActions').init.start,find(ast,node=>node.type==='VariableDeclarator'&&node.id.name==='availableActions').init.end)
    : source.slice(find(ast,node=>node.type==='VariableDeclarator'&&node.id.name==='activeStatusActions').init.arguments[0].start,find(ast,node=>node.type==='VariableDeclarator'&&node.id.name==='activeStatusActions').init.arguments[0].end);
  const select = (entry,now='2026-10-07T02:00:00Z') => {
    context.now=now;context.schedule={status:entry.status,start_time:entry.start,end_time:new Date(Date.parse(entry.start)+1800000).toISOString()};
    context.isCheckedIn=dates.isCheckedInAppointmentStatus(entry.status);context.isPending=dates.isPendingAppointmentStatus(entry.status);
    if(role==='staff')context.activeStatusAppointment={status:vm.runInContext('getDisplayStatus(schedule.status)',context),startTime:entry.start,endTime:context.schedule.end_time};
    return Array.from(vm.runInContext(role==='doctor'?selector:`(${selector})()`,context),action=>action.label);
  };
  for(const entry of cases){
    const expected=entry.name==='Checked in'?[role==='doctor'?'Completed':'Open Visit Form']:entry.actions;
    assert.deepEqual(select(entry),expected,role+' '+entry.name);deterministic++;
  }
  const entry={status:'scheduled',start:'2026-10-07T01:00:00Z'};
  assert.deepEqual(select(entry,'2026-10-06T15:59:59Z'),['Cancelled']);deterministic++;
  assert.deepEqual(select(entry,'2026-10-06T16:00:00Z'),['Check in','Cancelled']);deterministic++;
}
for(const width of [1440,1024,768,375]){
  for(const bottom of [100,890]){
    const menu=getAppointmentStatusPopoverPosition({triggerRect:{right:width-2,top:bottom-32,bottom},menuRect:{width:176,height:114},viewportWidth:width,viewportHeight:900});
    assert.ok(menu.left>=10&&menu.left+176<=width-10&&menu.top>=10&&menu.top+114<=890);deterministic++;
  }
}
console.log(`Deterministic action/eligibility/placement assertions: ${deterministic} passed.`);

// Reuse only the existing offline backend fixture; the success-toast verifier is unchanged.
const toastVerifier=await readFile(join(root,"scripts/verify-appointment-success-toasts.js"),"utf8");
const mockNode=find(parse(toastVerifier),node=>node.type==='VariableDeclarator'&&node.id.name==='mock');
assert.equal(mockNode.init.type,"TemplateLiteral");
const mock=mockNode.init.quasis[0].value.cooked.replace(' if(state.fail)return Promise.resolve',
  " if(name==='get_appointment_visit_form_type'){state.routes.push(args);return Promise.resolve(result({visit_form_type:'initial'}));}\n if(state.fail)return Promise.resolve");

const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {MemoryRouter,useLocation} from 'react-router-dom';import {_api} from '@iconify/react';
import '${root}/src/index.css';import '${root}/src/styles/doctor-dashboard.css';import '${root}/src/styles/staff-dashboard.css';import '${root}/src/styles/staff-doctor-parity.css';
import {DoctorAppointmentsContent as Doctor} from '${root}/src/pages/doctor/Doctor_Appointments.jsx';import Staff from '${root}/src/pages/staff/Staff_Appointments.jsx';
import Popover from '${root}/src/components/appointments/AppointmentStatusPopover.jsx';import {state,doctorId,patientId} from 'status-dropdown-mock';
_api.setFetch(async()=>({status:404}));const NativeDate=Date;let now='2026-10-07T02:00:00Z';
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return NativeDate.parse(now)}};
const root=createRoot(document.getElementById('root')),pause=(ms=80)=>new Promise(resolve=>setTimeout(resolve,ms));
const cases=${JSON.stringify(cases)};let assertions=0,failures=[],reports=[];
const check=(condition,message)=>{assertions++;if(!condition)failures.push(message);window.statusProgress=message};
const $=selector=>document.querySelector(selector),api=()=>window.statusTest;
function Route(){window.statusRoute=useLocation().pathname;return null}
const profile=<button className="doctor-profile-card" style={{width:240,height:66}}>Test Doctor profile</button>;
async function setup(role){now='2026-10-07T02:00:00Z';state.writes=[];state.notifications=[];state.routes=[];state.fail=false;state.notificationMode='ok';
 state.rows=cases.map((entry,index)=>({id:'status-'+index,patient_name:entry.name,patient_id:patientId,doctor_id:doctorId,doctor_name:'Test Doctor',
 title:'Prenatal Checkup',description:'',maternal_appointment_id:'MA-'+index,status:entry.status,start_time:entry.start,end_time:new NativeDate(NativeDate.parse(entry.start)+1800000).toISOString()}));
 flushSync(()=>root.render(<MemoryRouter key={role+Math.random()} initialEntries={['/'+role+'/appointments']}><Route/>
 <div className={'doctor-dashboard '+(role==='staff'?'staff-dashboard-shell':'')}><aside className="doctor-sidebar">Sidebar</aside><main className="doctor-main">
 {role==='doctor'?<div className="doctor-global-profile-slot">{profile}</div>:null}<div className="doctor-content">
 {role==='doctor'?<Doctor embedded doctorIdentity={{authUser:{id:doctorId},doctorDisplayName:'Test Doctor',loading:false}}/>:<Staff staffUserId="status-staff" headerAction={profile}/>}
 </div></main></div></MemoryRouter>));await pause(300);api().setPageSize(15);await pause(150);
}
function trigger(role,name){
 const rows=[...document.querySelectorAll(role==='doctor'?'.doctor-appointments-row':'.staff-appointments-table--body tr')];
 const row=rows.find(row=>[...row.querySelectorAll(role==='doctor'?':scope > span':'td')].some(cell=>cell.textContent===name));
 return row?.querySelector(role==='doctor'?'.doctor-appointment-status':'.staff-status-trigger');
}
async function open(role,name){
 const button=trigger(role,name);check(!!button,role+' '+name+' row exists');if(!button)throw new Error('Missing status trigger '+name);
 button.scrollIntoView({block:'center',inline:'nearest'});await pause();button.click();await pause(180);return button;
}
const labels=()=>[...document.querySelectorAll('.appointment-status-popover [role="menuitem"]')].map(item=>item.textContent);
async function menuCheck(role,entry){
 const button=await open(role,entry.name),menu=$('.appointment-status-popover');
 const expected=entry.name==='Checked in'?[role==='doctor'?'Completed':'Open Visit Form']:entry.actions;
 if(!expected.length){check(button.disabled,role+' '+entry.name+' terminal trigger disabled');check(!menu,role+' terminal has no menu');return}
 check(!button.disabled&&button.getAttribute('aria-expanded')==='true','actionable trigger opens menu');check(!!menu,'action menu renders');if(!menu)return;
 await Promise.allSettled(menu.getAnimations().map(animation=>animation.finished));
 check(JSON.stringify(labels())===JSON.stringify(expected),role+' '+entry.name+' retains exact valid actions');
 check(!menu.querySelector('.appointment-status-popover-current,.appointment-status-popover-divider'),'no repeated current-status header/divider');
 check(!labels().some(label=>['Pending','Overdue','Checked in'].includes(label)),'no selectable current state/Overdue');
 check(menu.textContent===expected.join(''),'menu contains only actions');
 check(menu.parentElement===document.body&&getComputedStyle(menu).position==='fixed','menu portal escapes table overflow');
 const rect=menu.getBoundingClientRect();check(rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,'popover within viewport');
 check(menu.scrollHeight<=menu.clientHeight&&menu.scrollWidth<=menu.clientWidth,'popover actions not clipped');
 reports.push({role,state:entry.name,pill:button.textContent,width:Math.round(rect.width),height:Math.round(rect.height)});
 if(entry.name==='Overdue today'||entry.name==='Overdue previous date')check(button.textContent.includes('Overdue'),'Overdue remains current pill condition');
 if(role==='doctor')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));else document.body.click();
 await pause();check(!$('.appointment-status-popover'),'existing role-specific dismissal works');
}
try{
 for(const role of ['doctor','staff']){
  await setup(role);for(const entry of cases)await menuCheck(role,entry);
  check(state.writes.length===0&&state.notifications.length===0,'inspection performs no mutation/notification');
  // Existing eligibility is a Manila date rule, including late check-in on that date.
  const future=state.rows[0];await(role==='doctor'?api().checkInAppointment(future):api().checkInAndOpenVisitForm(api().appointments.find(item=>item.id===future.id)));
  check(state.writes.length===0&&state.rows[0].status==='scheduled','future Check in guard prevents writes');
  await open(role,'Overdue today');$('.appointment-status-popover [role="menuitem"]').click();await pause(250);
  check(state.rows.find(row=>row.patient_name==='Overdue today').status==='checked_in','existing late-today Check in remains supported');
  check(state.notifications.length===0,'Check in does not change notification behavior');
  if(role==='staff')check(window.statusRoute==='/staff/appointments/status-3/initial-visit','Staff Check in retains exact visit navigation');
  await setup(role);await open(role,'Overdue previous date');[...document.querySelectorAll('.appointment-status-popover button')].find(button=>button.textContent==='No Show').click();await pause();
  check(!!$('.appointment-no-show-dialog'),'No Show still opens confirmation');check(state.writes.length===0,'No Show selection does not bypass confirmation');
  $('button[aria-label="Close No Show confirmation"]').click();await pause();
  await open(role,'Future date');[...document.querySelectorAll('.appointment-status-popover button')].find(button=>button.textContent==='Cancelled').click();await pause();
  const dialog=$('[role="dialog"]');check(!!dialog&&dialog.textContent.includes('Future date'),'Cancel retains intended appointment confirmation');check(state.writes.length===0,'Cancel selection does not bypass confirmation');
  dialog.querySelector('button[aria-label^="Close"]').click();await pause();
  await open(role,'Checked in');$('.appointment-status-popover button').click();await pause(150);
  check(window.statusRoute==='/'+role+'/appointments/status-5/initial-visit','checked-in action retains exact role visit navigation');check(state.writes.length===0,'visit action does not prematurely complete appointment');
 }
 // Shared renderer: busy actions and forwarded values are unchanged; empty actions have no menu.
 let chosen;flushSync(()=>root.render(<Popover actions={[{value:'cancelled',label:'Cancelled',tone:'cancelled',icon:'solar:close-circle-linear'}]} busy currentLabel="Pending" currentTone="pending" onAction={action=>chosen=action.value} position={{left:12,top:12}}/>));
 check($('.appointment-status-popover button').disabled,'busy action remains disabled');$('.appointment-status-popover button').click();check(!chosen,'busy click does not invoke transition');
 flushSync(()=>root.render(<Popover actions={[{value:'cancelled',label:'Cancelled',tone:'cancelled',icon:'solar:close-circle-linear'}]} onAction={action=>chosen=action.value} position={{left:12,top:12}}/>));
 $('.appointment-status-popover button').click();check(chosen==='cancelled','action value passes through unchanged');
 flushSync(()=>root.render(<Popover actions={[]} currentLabel="Pending" position={{left:12,top:12}}/>));check(!$('.appointment-status-popover'),'empty action list has no status-only menu');
 window.inspectStatusMenu=async(role)=>{await setup(role);await open(role,'Overdue today')};window.statusResult={assertions,failures,reports};
}catch(error){window.statusResult={assertions,failures:[...failures,error.stack],reports}}
`;

const result=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},
 plugins:[{name:'offline-status-dropdowns',enforce:'pre',
  resolveId(id){
   if(id.endsWith('status-dropdown-test.jsx'))return '\0status-dropdown-test.jsx';
   if(id==='status-dropdown-mock'||/\/supabaseClient(?:\.js)?$/.test(id))return '\0status-dropdown-mock.js';
   if(/\/automaticAppointmentNotification(?:\.js)?$/.test(id))return '\0status-dropdown-notify.js';
   if(/\/appointmentSms(?:\.js)?$/.test(id))return '\0status-dropdown-sms.js';
   if(/\/(AppointmentVisitForm|StaffPreConsultationForm|SendPatientNotificationAction)(?:\.jsx)?$/.test(id))return '\0status-dropdown-unused.jsx';
  },
  load(id){
   if(id==='\0status-dropdown-test.jsx')return fixture;if(id==='\0status-dropdown-mock.js')return mock;
   if(id==='\0status-dropdown-notify.js')return "export {notify as sendAutomaticAppointmentNotification} from 'status-dropdown-mock'";
   if(id==='\0status-dropdown-sms.js')return "export const appointmentSmsEvents={confirmed:'confirmed'};export async function requestAppointmentSms(){throw new Error('Unexpected SMS')}";
   if(id==='\0status-dropdown-unused.jsx')return 'export default function OfflineUnused(){return null}';
  },
  transform(source,id){for(const role of ['doctor','staff'])if(id.replaceAll('\\','/').endsWith('/'+(role==='doctor'?'Doctor':'Staff')+'_Appointments.jsx')){
   assert.ok(source.includes('  if (visitRoute) {'));
   return source.replace('  if (visitRoute) {',`  window.statusTest={setPageSize,${role==='doctor'?'checkInAppointment':'checkInAndOpenVisitForm,appointments'}};\n  if (visitRoute) {`);
  }}
 },react()],build:{write:false,minify:false,lib:{entry:'status-dropdown-test.jsx',formats:['es']}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(output=>output.output),code=outputs.find(output=>output.type==='chunk').code.replaceAll('</script','<\\/script');
const css=outputs.filter(output=>output.type==='asset'&&output.fileName.endsWith('.css')).map(output=>output.source).join('\n');
const temporary=await mkdtemp(join(tmpdir(),'maternal-status-dropdown-browser-')),html=join(temporary,'fixture.html');
await writeFile(html,`<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.replace(/@import[^;]+;/g,'')}</style><div id="root"></div><script type="module">${code}</script>`);
const candidates=process.env.HEADLESS_BROWSER?[process.env.HEADLESS_BROWSER]:['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'];
let executable;for(const candidate of candidates){try{await access(candidate);executable=candidate;break}catch{/* Try next installed browser. */}}
assert.ok(executable,'Set HEADLESS_BROWSER to installed Chrome/Chromium');
const browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${join(temporary,'browser-profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));let socket,cdp;
try{
 let port;for(let attempt=0;attempt<100&&!port;attempt++){try{port=(await readFile(join(temporary,'browser-profile/DevToolsActivePort'),'utf8')).split('\n')[0]}catch{await pause()}}
 assert.ok(port,'Offline Chrome starts');const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 let sequence=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;pending.delete(message.id);if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result)};
 cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(new Error('Browser command timeout: '+method))},5000).unref()});
 await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});let total=0,failed=0;
 const widths=process.argv.slice(2).map(Number);for(const width of widths.length?widths:[1440,1024,768,375]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:pathToFileURL(html).href});let observation;
  for(let attempt=0;attempt<500&&!observation;attempt++){await pause();observation=(await cdp('Runtime.evaluate',{expression:'window.statusResult',returnByValue:true})).result.value}
  if(!observation)console.error((await cdp('Runtime.evaluate',{expression:'({progress:window.statusProgress,body:document.body.textContent.slice(-600)})',returnByValue:true})).result.value);
  assert.ok(observation,'Status dropdown fixture completes');total+=observation.assertions;failed+=observation.failures.length;
  console.log(`${width}px: ${observation.assertions} assertions, ${observation.failures.length} failures; ${JSON.stringify(observation.reports)}`);observation.failures.forEach(failure=>console.error(failure));
  if(!observation.failures.length)for(const role of ['doctor','staff']){
   await cdp('Runtime.evaluate',{expression:`window.inspectStatusMenu('${role}')`,awaitPromise:true});const screenshot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(temporary,`${role}-${width}.png`),Buffer.from(screenshot.data,'base64'));
  }
 }
 console.log(`Browser total: ${total} assertions, ${failed} failures. Backend/notifications mocked; HTTP(S) blocked. Screenshots: ${temporary}`);assert.equal(failed,0,'Status dropdown regressions pass');
}finally{if(cdp)await cdp('Browser.close').catch(()=>browser.kill());else browser.kill();socket?.close()}
