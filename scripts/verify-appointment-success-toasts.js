/* global process */
// Exercises the current page handlers and markup with offline Supabase/notification fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import postcss from "postcss";
import { buildAppointmentSuccessFeedback } from "../src/lib/appointmentSuccessFeedback.js";

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const audit = process.argv.includes("--audit");
const sample = { patient_name: "Saved Patient", start_time: "2026-10-09T00:30:00Z" };
for (const action of ["created", "rescheduled", "cancelled", "no-show"]) {
  const feedback = buildAppointmentSuccessFeedback(action, sample, { patient_name: "Stale Patient" });
  assert.match(feedback.message, /Saved Patient/);
  assert.doesNotMatch(feedback.message, /Stale Patient/);
  if (action !== "no-show") assert.match(feedback.message, /October 09, 2026 at 8:30 AM/);
}
assert.match(buildAppointmentSuccessFeedback("created", null, sample).message, /Saved Patient/);
assert.match(buildAppointmentSuccessFeedback("cancelled", { name: "Mapped Patient", startTime: sample.start_time }).message, /Mapped Patient/);
assert.doesNotMatch(buildAppointmentSuccessFeedback("created", {}).message, /Invalid Date|- at -/);
postcss.parse(await readFile(join(root, "src/styles/appointment-ui-system.css"), "utf8"));
console.log("Saved/mapped/fallback feedback assertions and PostCSS check passed.");

const mock = `
export const patientId='11111111-1111-4111-8111-111111111111';
export const doctorId='22222222-2222-4222-8222-222222222222';
export const state={rows:[],writes:[],notifications:[],fail:false,notificationMode:'ok',deferred:[],returnedName:'Saved Patient',rescheduled:true};
export const patient={id:patientId,full_name:'Selected Patient',patient_id:'PAT-001',status:'active'};
export function seed(){state.rows=[{id:'appointment-1',patient_id:patientId,doctor_id:doctorId,patient_name:'First Patient',doctor_name:'Test Doctor',
 title:'Prenatal Checkup',description:'',start_time:'2026-10-09T00:30:00Z',end_time:'2026-10-09T01:00:00Z',status:'scheduled'},
 {id:'appointment-2',patient_id:patientId,doctor_id:doctorId,patient_name:'Second Patient',doctor_name:'Test Doctor',title:'Prenatal Checkup',
 description:'',start_time:'2026-10-06T00:30:00Z',end_time:'2026-10-06T01:00:00Z',status:'scheduled'}];}
const result=data=>({data,error:null});
function query(table){let payload,id,single=false;const chain={select(){return this},order(){return this},limit(){return this},ilike(){return this},
 eq(key,value){if(key==='id')id=value;return this},in(){return this},gte(){return this},lt(){return this},
 maybeSingle(){single=true;return this},single(){single=true;return this},update(value){payload=value;return this},
 then(resolve,reject){
  if(payload){if(state.fail)return Promise.resolve({data:null,error:{message:'Synthetic mutation failure'}}).then(resolve,reject);
   state.writes.push({table,payload,id});if(table==='schedule')state.rows=state.rows.map(row=>row.id===id?{...row,...payload}:row);}
  const rows=table==='schedule'?state.rows:table==='patients'?[patient]:[];
  return Promise.resolve(result(single?rows.find(row=>!id||row.id===id):rows)).then(resolve,reject);
 }};return chain;}
function rpc(name,args){
 if(name==='get_doctor_patient_directory'||name==='get_staff_patient_directory')return {select(){return this},order(){return this},
  then(resolve,reject){return Promise.resolve(result([patient])).then(resolve,reject)}};
 if(name==='get_walkin_registration_availability')return Promise.resolve(result([{doctor_id:doctorId,doctor_name:'Test Doctor'}]));
 if(name==='get_operational_appointment_policy')return Promise.resolve(result({timezone:'Asia/Manila',clinic_opening_time:'08:00',clinic_closing_time:'17:00',
  default_appointment_duration_minutes:30,updated_at:'2026-10-01T00:00:00Z'}));
 if(state.fail)return Promise.resolve({data:null,error:{message:'Synthetic mutation failure'}});
 if(name==='create_standard_appointment'){
  const row={...state.rows[0],id:'created-'+state.writes.length,patient_name:state.returnedName,start_time:args.p_start_time,
   end_time:new Date(Date.parse(args.p_start_time)+1800000).toISOString(),title:args.p_title};
  state.rows.push(row);state.writes.push({name,args});return Promise.resolve(result(row));}
 if(name==='reschedule_appointment'){
  const row={...state.rows.find(item=>item.id===args.p_schedule_id),patient_name:state.returnedName,start_time:args.p_new_start_time,
   end_time:args.p_new_end_time,description:args.p_description,status:'scheduled'};
  state.rows=state.rows.map(item=>item.id===row.id?row:item);state.writes.push({name,args});
  return Promise.resolve(result({schedule:row,rescheduled:state.rescheduled,appointment_event_id:'synthetic-event'}));}
 throw new Error('Unexpected offline RPC: '+name);
}
export const supabase={from:query,rpc,channel(){return {on(){return this},subscribe(){return this}}},removeChannel(){},
 auth:{async getUser(){return result({user:{id:doctorId}})}}};
export function notify(args){state.notifications.push(args);if(state.notificationMode==='defer')return new Promise(resolve=>state.deferred.push(resolve));
 return Promise.resolve(state.notificationMode==='fail'?{ok:false,error:{message:'Synthetic delivery failure'}}:
 state.notificationMode==='skip'?{ok:false,skipped:true}:{ok:true});}
`;

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MemoryRouter} from 'react-router-dom';
import {_api} from '@iconify/react';
import '${root}/src/index.css';
import '${root}/src/styles/doctor-dashboard.css';
import '${root}/src/styles/staff-dashboard.css';
import '${root}/src/styles/staff-doctor-parity.css';
import {DoctorAppointmentsContent as Doctor} from '${root}/src/pages/doctor/Doctor_Appointments.jsx';
import Staff from '${root}/src/pages/staff/Staff_Appointments.jsx';
import {state,seed,doctorId,patientId} from 'appointment-toast-mock';
_api.setFetch(async()=>({status:404}));
const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-07T02:00:00Z']))}static now(){return NativeDate.parse('2026-10-07T02:00:00Z')}};
const root=createRoot(document.getElementById('root')),pause=(ms=80)=>new Promise(resolve=>setTimeout(resolve,ms));
const $=selector=>document.querySelector(selector);let assertions=0,failures=[],reports=[];
const check=(condition,message)=>{assertions++;if(!condition)failures.push(message);window.toastProgress=message};
const api=()=>window.appointmentToastTest;
const mapped=row=>({id:row.id,name:row.patient_name,patientId:row.patient_id,startTime:row.start_time,endTime:row.end_time,
 status:'Pending',databaseStatus:'scheduled',description:'',doctorName:row.doctor_name});
const profile=<button className="doctor-profile-card" id="fixture-profile" style={{width:240,height:66}}>Test Doctor profile</button>;
async function setup(role){seed();state.writes=[];state.notifications=[];state.fail=false;state.notificationMode='ok';state.deferred=[];state.returnedName='Saved Patient';state.rescheduled=true;
 flushSync(()=>root.render(<MemoryRouter key={role+Math.random()} initialEntries={['/'+role+'/appointments']}>
 <div className={'doctor-dashboard '+(role==='staff'?'staff-dashboard-shell':'')}><aside className="doctor-sidebar">Sidebar</aside><main className="doctor-main">
 {role==='doctor'?<div className="doctor-global-profile-slot">{profile}</div>:null}<div className="doctor-content">
 {role==='doctor'?<Doctor embedded doctorIdentity={{authUser:{id:doctorId},doctorDisplayName:'Test Doctor',loading:false}}/>:<Staff staffUserId="test-staff" headerAction={profile}/>}
 </div></main></div></MemoryRouter>));await pause(400);}
const close=async()=>{$('.appointment-success-toast__close')?.click();await pause();check(!$('.appointment-success-toast'),'manual close removes toast');check(!$('.appointment-ui-header').style.marginBottom,'reserved notification space is released after close')};
async function toastChecks(role,action,name,dateText){await pause(250);const toast=$('.appointment-success-toast');check(!!toast,role+' '+action+' success toast');if(!toast)return;
 await Promise.allSettled(toast.getAnimations().map(animation=>animation.finished));
 check(document.querySelectorAll('.appointment-success-toast').length===1,'single toast');
 const titles={created:'Appointment created',rescheduled:'Appointment rescheduled',cancelled:'Appointment cancelled','no-show':'Appointment marked as No Show'};
 check(toast.querySelector('strong')?.textContent===titles[action],role+' '+action+' title');
 check(toast.querySelector('.appointment-success-toast__copy span')?.textContent.includes(name),role+' '+action+' actual patient');
 if(dateText)check(toast.textContent.includes(dateText),role+' '+action+' actual appointment date/time');
 check(toast.getAttribute('role')==='status'&&toast.getAttribute('aria-live')==='polite'&&toast.getAttribute('aria-atomic')==='true','polite atomic status');
 check(!$('.doctor-appointments-status-message, .staff-appointments-status-message'),'no duplicate inline success banner');
 const rect=toast.getBoundingClientRect();check(rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,'toast fits viewport');
 const overlaps=other=>rect.left<other.right&&rect.right>other.left&&rect.top<other.bottom&&rect.bottom>other.top;
 const blocked=[...document.querySelectorAll('button,input,select,textarea')].filter(element=>!toast.contains(element)&&!element.disabled)
  .filter(element=>{const box=element.getBoundingClientRect();if(!box.width||!box.height||box.top>=innerHeight||box.bottom<=0||!overlaps(box))return false;
   // Existing modal layers sit above the toast; verify actual obstruction there.
   if(element.closest('[role="dialog"]'))return toast.contains(document.elementFromPoint((Math.max(rect.left,box.left)+Math.min(rect.right,box.right))/2,(Math.max(rect.top,box.top)+Math.min(rect.bottom,box.bottom))/2));
   return true;});
 check(!blocked.length,role+' '+action+' avoids controls: '+blocked.map(element=>element.id||element.textContent||element.getAttribute('aria-label')).join(','));
 const regions=[...document.querySelectorAll('.appointment-ui-toolbar,.doctor-appointment-summary,.staff-appointment-summary,.appointment-ui-table-card,.doctor-profile-card,.staff-profile-card,.doctor-profile-dropdown,.appointment-status-popover')];
 const covered=regions.filter(element=>overlaps(element.getBoundingClientRect()));
 check(!covered.length,role+' '+action+' avoids primary regions: '+covered.map(element=>element.className).join(','));
 check(document.documentElement.scrollWidth<=innerWidth,'no horizontal page overflow');
 check(toast.scrollWidth<=toast.clientWidth&&toast.scrollHeight<=toast.clientHeight,'toast copy and close button are not clipped');
 const toolbar=$('.appointment-ui-toolbar').getBoundingClientRect();
 if(toolbar.top>=0)check(rect.bottom<=toolbar.top,'toast occupies notification lane above toolbar');
 if(innerWidth>640)check(Math.abs(rect.right-toast.closest('.appointment-workspace').getBoundingClientRect().right)<1,'toast right edge aligned with main content');
 check(getComputedStyle(toast).animationName===(matchMedia('(prefers-reduced-motion: reduce)').matches?'none':innerWidth<=640?'appointment-success-toast-mobile-in':'appointment-success-toast-in'),'reduced-motion behavior');
 const button=toast.querySelector('button');button.focus();
 const activeDoctorDialog=role==='doctor'?document.querySelector('.appointment-add-card[role="dialog"]'):null;
 check(button.getAttribute('aria-label')==='Dismiss success notification' && (activeDoctorDialog
  ? activeDoctorDialog.contains(document.activeElement) && document.activeElement!==button
  : document.activeElement===button),activeDoctorDialog?'Doctor modal blocks background toast keyboard focus':'keyboard-accessible labelled close');
 reports.push({role,action,top:Math.round(rect.top),height:Math.round(rect.height)});
}
try{for(const role of ['doctor','staff']){
 await setup(role);
 if(role==='doctor'){api().openAddAppointment();await pause(200);api().setForm({patient_name:'Selected Patient',title:'Prenatal Checkup',description:'',appointment_date:'2026-10-10',appointment_time:'09:15'});}
 else {api().setIsAddAppointmentOpen(true);api().setAddAppointmentForm({patientRecordId:patientId,patientName:'Selected Patient',doctorId,doctorName:'Test Doctor',appointmentType:'Prenatal Checkup',date:'2026-10-10',startTime:'09:15',category:'prenatal',notes:''});}
 await pause();state.notificationMode=role==='doctor'?'defer':'ok';
 await (role==='doctor'?api().createAppointment({preventDefault(){}}):api().saveAppointment({preventDefault(){}}));
 await toastChecks(role,'created','Saved Patient','October 10, 2026 at 9:15 AM');
 const createdToast=$('.appointment-success-toast');if(role==='doctor'){state.deferred.shift()({ok:true});await pause();check($('.appointment-success-toast')===createdToast,'Doctor creation delivery completion does not remount duplicate toast');}
 check(state.notifications.length===1,'create notification dispatch unchanged');await close();
 state.notificationMode='ok';api().setRescheduleForm({date:'2026-10-11',time:'10:45',message:''});
 role==='doctor'?api().setRescheduleSchedule(state.rows[0]):api().setRescheduleAppointment(mapped(state.rows[0]));await pause();
 await api().saveRescheduleAppointment({preventDefault(){}});await toastChecks(role,'rescheduled','Saved Patient','October 11, 2026 at 10:45 AM');await close();
 const original=state.rows[0];api().setCancelReason('Patient requested cancellation');
 role==='doctor'?api().setCancelConfirmationSchedule(original):api().setCancelConfirmationAppointment(mapped(original));await pause();
 state.notificationMode=role==='doctor'?'defer':'ok';await api().confirmCancelAppointment();
 await toastChecks(role,'cancelled','Saved Patient','October 11, 2026 at 10:45 AM');
 const cancelledToast=$('.appointment-success-toast');if(role==='doctor'){state.deferred.shift()({ok:true});await pause();check($('.appointment-success-toast')===cancelledToast,'Doctor cancellation delivery completion does not remount duplicate toast');}await close();
 state.notificationMode='ok';const noShow=state.rows[1];role==='doctor'?api().setNoShowConfirmationSchedule(noShow):api().setNoShowConfirmationAppointment(mapped(noShow));await pause();
 await(role==='doctor'?api().confirmNoShowAppointment():api().confirmNoShow());await toastChecks(role,'no-show','Second Patient');
 check(state.rows[1].status==='no_show','No Show persisted mapping unchanged');check(state.notifications.length===3,'No Show does not add notification dispatch');
 await pause(4300);check(!!$('.appointment-success-toast'),'toast remains until approximately five seconds');await pause(800);check(!$('.appointment-success-toast'),'toast auto-dismisses after five seconds');check(!$('.appointment-ui-header').style.marginBottom,'auto-dismiss releases notification space');
 if(role==='staff'){
  await setup(role);api().setEditingAppointmentId(state.rows[0].id);
  api().setAddAppointmentForm({patientRecordId:patientId,patientName:'Selected Patient',doctorId,doctorName:'Test Doctor',appointmentType:'Prenatal Checkup',date:'2026-10-12',startTime:'11:30',category:'prenatal',notes:''});await pause();
  await api().saveAppointment({preventDefault(){}});await toastChecks(role,'rescheduled','Saved Patient','October 12, 2026 at 11:30 AM');await close();
 }
 // An unchanged appointment time keeps the existing details-saved feedback.
 await setup(role);state.rescheduled=false;api().setRescheduleForm({date:'2026-10-09',time:'08:30',message:'Details only'});
 role==='doctor'?api().setRescheduleSchedule(state.rows[0]):api().setRescheduleAppointment(mapped(state.rows[0]));await pause();await api().saveRescheduleAppointment({preventDefault(){}});await pause();
 check($('.appointment-success-toast')?.textContent.includes('Appointment details saved. The appointment time did not change.'),'details-only save is not mislabeled rescheduled');await close();
 // Failed mutations and invalid confirmation stay in their existing error paths.
 await setup(role);
 seed();state.fail=true;role==='doctor'?api().setNoShowConfirmationSchedule(state.rows[1]):api().setNoShowConfirmationAppointment(mapped(state.rows[1]));await pause();
 await(role==='doctor'?api().confirmNoShowAppointment():api().confirmNoShow());check(!$('.appointment-success-toast'),'failed No Show has no success toast');
 check(state.rows[1].status==='scheduled','failed mutation keeps status');
 for(const action of ['created','rescheduled','cancelled']){
  await setup(role);state.fail=true;
  if(action==='created'){
   if(role==='doctor'){api().openAddAppointment();await pause(150);api().setForm({patient_name:'Selected Patient',title:'Prenatal Checkup',description:'',appointment_date:'2026-10-10',appointment_time:'09:15'});}
   else {api().setAddAppointmentForm({patientRecordId:patientId,patientName:'Selected Patient',doctorId,doctorName:'Test Doctor',appointmentType:'Prenatal Checkup',date:'2026-10-10',startTime:'09:15',category:'prenatal',notes:''});}
   await pause();await(role==='doctor'?api().createAppointment({preventDefault(){}}):api().saveAppointment({preventDefault(){}}));
  }else if(action==='rescheduled'){
   api().setRescheduleForm({date:'2026-10-11',time:'10:45',message:''});role==='doctor'?api().setRescheduleSchedule(state.rows[0]):api().setRescheduleAppointment(mapped(state.rows[0]));await pause();await api().saveRescheduleAppointment({preventDefault(){}});
  }else{
   api().setCancelReason('Patient requested cancellation');role==='doctor'?api().setCancelConfirmationSchedule(state.rows[0]):api().setCancelConfirmationAppointment(mapped(state.rows[0]));await pause();await api().confirmCancelAppointment();
  }
  check(!$('.appointment-success-toast'),role+' failed '+action+' has no success toast');check(state.writes.length===0,'failed action records no mutation');
 }
 await setup(role);state.notificationMode='fail';api().setCancelReason('Patient requested cancellation');
 role==='doctor'?api().setCancelConfirmationSchedule(state.rows[0]):api().setCancelConfirmationAppointment(mapped(state.rows[0]));await pause();await api().confirmCancelAppointment();await pause();
 check($('.doctor-appointments-status-message, .staff-appointments-status-message')?.textContent.includes('notification could not be sent'),'notification failure retains inline warning');
 if(role==='doctor')await close();
 await setup(role);api().showSuccessMessage({title:'Appointment created',message:'A very long patient name '.repeat(6)+' has been scheduled for October 12, 2026 at 11:30 AM.'});await pause(250);
 const longToast=$('.appointment-success-toast');check(longToast.scrollWidth<=longToast.clientWidth,'long patient name/date wraps without toast overflow');
 await toastChecks(role,'created','A very long patient name','October 12, 2026 at 11:30 AM');
 const previousToast=$('.appointment-success-toast');api().showSuccessMessage({title:'Appointment created',message:'A very long patient name '.repeat(6)+' has been scheduled for October 12, 2026 at 11:30 AM.'});await pause(250);
 check($('.appointment-success-toast')!==previousToast,'repeated identical success repositions its new toast');
 await toastChecks(role,'created','A very long patient name','October 12, 2026 at 11:30 AM');
 if(innerWidth<=640)window.scrollTo(0,180);else $('.doctor-main').scrollTop=180;
 await pause(300);await toastChecks(role,'created','A very long patient name','October 12, 2026 at 11:30 AM');
 window.scrollTo(0,0);$('.doctor-main').scrollTop=0;await pause(300);await close();
 api().showSuccessMessage({title:'Appointment created',message:'A long synthetic patient name has been scheduled for October 10, 2026 at 9:15 AM.'});await pause(250);
 if(role==='doctor')api().openAddAppointment();else api().setIsAddAppointmentOpen(true);
 await pause(300);await toastChecks(role,'created','A long synthetic patient name','October 10, 2026 at 9:15 AM');
 $('button[aria-label^="Close add appointment"]').click();await pause(300);
 const statusButton=$(role==='doctor'?'.doctor-appointment-status':'.staff-status-trigger');statusButton.scrollIntoView({block:'center'});await pause(150);statusButton.click();await pause(250);
 check(!!$('.appointment-status-popover'),'existing status menu opens while toast is active');await toastChecks(role,'created','A long synthetic patient name','October 10, 2026 at 9:15 AM');
 if(role==='doctor')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));else document.body.click();await pause(150);
 check(!$('.appointment-status-popover'),'existing status menu dismisses');window.scrollTo(0,0);$('.doctor-main').scrollTop=0;await pause(150);await close();
 }
 window.toastResult={assertions,failures,reports};
 window.inspectAppointmentToast=async role=>{await setup(role);api().showSuccessMessage({title:'Appointment created',message:'A long synthetic patient name has been scheduled for October 10, 2026 at 9:15 AM.'});await pause(250)};
}catch(error){window.toastResult={assertions,failures:[...failures,error.stack],reports}}
`;

const exposure = {
  doctor: "showSuccessMessage,createAppointment,openAddAppointment,setForm,saveRescheduleAppointment,setRescheduleForm,setRescheduleSchedule,confirmCancelAppointment,setCancelReason,setCancelConfirmationSchedule,confirmNoShowAppointment,setNoShowConfirmationSchedule",
  staff: "showSuccessMessage,saveAppointment,setAddAppointmentForm,setEditingAppointmentId,setIsAddAppointmentOpen,saveRescheduleAppointment,setRescheduleForm,setRescheduleAppointment,confirmCancelAppointment,setCancelReason,setCancelConfirmationAppointment,confirmNoShow,setNoShowConfirmationAppointment",
};
const result = await build({ root, configFile:false,logLevel:"error",define:{"process.env.NODE_ENV":'"production"'},
  plugins:[{name:"offline-appointment-toasts",enforce:"pre",
    resolveId(id){
      if(id.endsWith("appointment-toast-test.jsx"))return "\0appointment-toast-test.jsx";
      if(id==="appointment-toast-mock"||/\/supabaseClient(?:\.js)?$/.test(id))return "\0appointment-toast-mock.js";
      if(/\/automaticAppointmentNotification(?:\.js)?$/.test(id))return "\0appointment-toast-notify.js";
      if(/\/appointmentSms(?:\.js)?$/.test(id))return "\0appointment-toast-sms.js";
      if(/\/(AppointmentVisitForm|StaffPreConsultationForm|SendPatientNotificationAction)(?:\.jsx)?$/.test(id))return "\0appointment-toast-null.jsx";
    },
    load(id){
      if(id==="\0appointment-toast-test.jsx")return fixture;
      if(id==="\0appointment-toast-mock.js")return mock;
      if(id==="\0appointment-toast-notify.js")return "export {notify as sendAutomaticAppointmentNotification} from 'appointment-toast-mock'";
      if(id==="\0appointment-toast-sms.js")return "export const appointmentSmsEvents={confirmed:'confirmed'};export async function requestAppointmentSms(){throw new Error('Unexpected SMS in toast fixture')}";
      if(id==="\0appointment-toast-null.jsx")return "export default function OfflineUnused(){return null}";
    },
    transform(source,id){for(const role of ["doctor","staff"]){if(id.replaceAll("\\","/").endsWith('/'+(role==='doctor'?'Doctor':'Staff')+'_Appointments.jsx')){
      assert.ok(source.includes('  if (visitRoute) {'));
      return source.replace('  if (visitRoute) {',`  window.appointmentToastTest={${exposure[role]}};\n  if (visitRoute) {`);
    }}}
  },react()],build:{write:false,minify:false,lib:{entry:"appointment-toast-test.jsx",formats:["es"]}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(output=>output.output);
const code=outputs.find(output=>output.type==="chunk").code.replaceAll("</script","<\\/script");
const css=outputs.filter(output=>output.type==="asset"&&output.fileName.endsWith(".css")).map(output=>output.source).join("\n");
const offlineCss=postcss.parse(css);offlineCss.walkAtRules('import',rule=>rule.remove());
const temporary=await mkdtemp(join(tmpdir(),"maternal-appointment-toast-browser-")),html=join(temporary,"fixture.html");
await writeFile(html,`<meta name="viewport" content="width=device-width, initial-scale=1"><style>${offlineCss}</style><div id="root"></div><script type="module">${code}</script>`);
const candidates=process.env.HEADLESS_BROWSER?[process.env.HEADLESS_BROWSER]:["C:/Program Files/Google/Chrome/Application/chrome.exe","/usr/bin/chromium","/usr/bin/google-chrome"];
let executable;for(const candidate of candidates){try{await access(candidate);executable=candidate;break}catch{/* Try next installed browser. */}}
assert.ok(executable,"Set HEADLESS_BROWSER to an installed Chrome/Chromium executable");
const browser=spawn(executable,["--headless=new","--no-sandbox","--disable-gpu","--disable-extensions","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${join(temporary,"browser-profile")}`,"about:blank"],{windowsHide:true,stdio:"ignore"});
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));let socket,cdp;
try{
 let port;for(let attempt=0;attempt<100&&!port;attempt++){try{port=(await readFile(join(temporary,"browser-profile/DevToolsActivePort"),"utf8")).split("\n")[0]}catch{await pause()}}
 assert.ok(port,"Offline Chrome starts");const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 socket=new WebSocket(tabs.find(tab=>tab.type==="page").webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 let sequence=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;pending.delete(message.id);if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result)};
 cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(new Error('Browser command timeout: '+method))},5000).unref()});
 await cdp("Network.enable");await cdp("Network.setBlockedURLs",{urls:["http://*","https://*"]});let total=0,failed=0;
 const widths=process.argv.slice(2).filter(argument=>/^\d+$/.test(argument)).map(Number);for(const width of widths.length?widths:[1440,1180,1024,768,375]){
  await cdp("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:width===375?"reduce":"no-preference"}]});
  await cdp("Page.navigate",{url:pathToFileURL(html).href});let observation;
  for(let attempt=0;attempt<600&&!observation;attempt++){await pause();observation=(await cdp("Runtime.evaluate",{expression:"window.toastResult",returnByValue:true})).result.value}
  if(!observation)console.error((await cdp("Runtime.evaluate",{expression:"({progress:window.toastProgress,body:document.body.textContent.slice(-600)})",returnByValue:true})).result.value);
  assert.ok(observation,"Offline appointment fixture completes");total+=observation.assertions;failed+=observation.failures.length;
  console.log(`${width}px: ${observation.assertions} assertions, ${observation.failures.length} failures; ${JSON.stringify(observation.reports)}`);observation.failures.forEach(failure=>console.error(failure));
  for(const role of ['doctor','staff']){
   await cdp("Runtime.evaluate",{expression:`window.inspectAppointmentToast?.('${role}')`,awaitPromise:true});
   const screenshot=await cdp("Page.captureScreenshot",{format:"png"});await writeFile(join(temporary,`${role}-${width}.png`),Buffer.from(screenshot.data,"base64"));
   await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
   const focus=(await cdp("Runtime.evaluate",{expression:"(()=>{const close=document.querySelector('.appointment-success-toast__close');close.focus();return getComputedStyle(close).outlineStyle!=='none'})()",returnByValue:true})).result.value;
   assert.ok(focus,role+' visible keyboard close focus');
   await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r",unmodifiedText:"\r"});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
   await pause();
   assert.equal((await cdp("Runtime.evaluate",{expression:"!!document.querySelector('.appointment-success-toast')",returnByValue:true})).result.value,false,role+' Enter dismisses toast');
  }
 }
 console.log(`Browser total: ${total} assertions, ${failed} failures. All backend/notification calls mocked; HTTP(S) blocked. Screenshots: ${temporary}`);
 if(!audit)assert.equal(failed,0,"Appointment success-toast regressions pass");
}finally{if(cdp)await cdp("Browser.close").catch(()=>browser.kill());else browser.kill();socket?.close()}
