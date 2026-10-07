/* global process */
// Offline UI regression: installed Chrome/Chromium; no Supabase, SMS, or auth network.
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
import { buildReminderSuccessToast } from "../src/lib/reminderFeedback.js";

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
for (const name of ["success-toast.css", "reminder-date-time-picker.css"]) {
  postcss.parse(await readFile(join(root, "src/styles", name), "utf8"), { from: name });
}
const sample = { appointment: { patientName: "Synthetic Patient" }, appointmentAt: "2026-10-09T00:30:00Z",
  savedReminder: { remind_at: "2026-10-06T18:40:00Z", repeat_mode: "none" } };
assert.match(buildReminderSuccessToast(sample).message, /October 7, 2026 at 2:40 AM/);
assert.match(buildReminderSuccessToast(sample).details[0], /October 9, 2026 at 8:30 AM/);
assert.equal(buildReminderSuccessToast({ ...sample, updated: true }).title, "Reminder updated");
for (const [mode, label] of [["none", "No repeat"], ["daily", "Daily"], ["hourly", "Every Hour"]]) {
  assert.equal(buildReminderSuccessToast({ ...sample, savedReminder: { ...sample.savedReminder, repeat_mode: mode } }).details[1], `Repeat: ${label}`);
}
console.log("Saved-payload feedback: 6 assertions passed; both CSS files parsed.");

const patientSource = await readFile(join(root, "src/pages/patient/Patient_PWA_Reminder.jsx"), "utf8");
const medicationHandler = patientSource.match(/ {2}const handleMedicationOccurrenceAction = async [\s\S]*?\n {2}};/)?.[0];
assert.ok(medicationHandler, "Exercise the current Patient medication handler");
const appointmentFixtures = [];
for (const role of ["doctor", "staff"]) {
  const page = await readFile(join(root, `src/pages/${role}/${role === "doctor" ? "Doctor" : "Staff"}_Appointments.jsx`), "utf8");
  const helper = page.match(/ {2}const showSuccessMessage = useCallback\([\s\S]*?\n {2}\);/)?.[0];
  const toast = page.match(/\{successMessage \? \([\s\S]*?\) : null\}/)?.[0];
  assert.ok(helper && toast, `${role} existing floating toast contract`);
  appointmentFixtures.push(`function ${role}AppointmentToastFixture() {
    const [successMessage,setSuccessMessage]=useState('');
    const [successTitle,setSuccessTitle]=useState('');
    const successToastRef=useRef(null);
    const [statusMessage,setStatusMessage]=useState('');
    const [statusMessageVersion,setStatusMessageVersion]=useState(0);
    const successTimerRef=useRef(null);
    const clearSuccessTimer=useCallback(()=>clearTimeout(successTimerRef.current),[]);
    useEffect(()=>()=>clearSuccessTimer(),[clearSuccessTimer]);
    ${helper}
    const dismissSuccessMessage=()=>{clearSuccessTimer();setSuccessMessage('');setStatusMessage('')};
    return <section className="${role}-appointments-page"><button id="existing-toast" onClick={()=>showSuccessMessage('Appointment marked as No Show.')}>No Show fixture</button>${toast}<span>{statusMessage}</span></section>;
  }`);
}

const mock = `
export const patientId = '11111111-1111-4111-8111-111111111111';
export const state = {writes: [], reminders: [], fail: false, failSchedule: '', authWrites: 0, doseStatus: '',
 reminderReads:0,readDelay:0,readError:false,activeReads:0,peakReads:0,channels:[]};
export function reminderEvent(row) {
 state.channels.filter(channel=>channel.active).forEach(channel=>channel.handlers
  .filter(handler=>handler.options.table==='reminders').forEach(handler=>handler.callback({eventType:'UPDATE',new:row,old:{id:row.id}})));
}
export function reconnect() {
 state.channels.filter(channel=>channel.active && channel.name.startsWith('doctor-reminder-appointment-data-'))
  .forEach(channel=>channel.statusCallback?.('SUBSCRIBED'));
}
const schedules = [0,1].map(index => ({id: 'appointment-' + index, patient_id: patientId,
 patient_name: 'Synthetic Patient', doctor_name: 'Test Doctor', title: 'Prenatal Checkup',
 start_time: index ? '2026-11-09T00:30:00Z' : '2026-10-09T00:30:00Z',
 end_time: index ? '2026-11-09T01:00:00Z' : '2026-10-09T01:00:00Z', status: 'scheduled'}));
function query(table) {
 let operation = 'read', payload, matchId;
 const chain = {select() {return this}, order() {return this}, limit() {return this}, in() {return this},
  gte() {return this}, lt() {return this}, ilike() {return this}, eq(key,value) {if(key==='id') matchId=value; return this},
  maybeSingle() {return this}, insert(value) {operation='insert'; payload=value; return this},
  update(value) {operation='update'; payload=value; return this}, delete() {operation='delete'; return this},
  then(resolve,reject) {
   if(operation !== 'read') {
    const record = Array.isArray(payload) ? payload[0] : payload;
    if(state.fail || (state.failSchedule && record?.schedule_id===state.failSchedule)) return Promise.resolve({data:null,error:{message:'Synthetic save failure'}}).then(resolve,reject);
    state.writes.push({table,operation,payload:record});
    if(table==='reminders') {
     if(operation==='update') state.reminders=state.reminders.map(row=>row.id===matchId?{...row,...record}:row);
     else state.reminders.push({...record,id:'reminder-'+state.writes.length,created_at:new Date().toISOString()});
    }
   }
   let data = table==='schedule'? schedules : table==='directory' ? [{id:patientId,patient_id:'PAT-001',full_name:'Synthetic Patient',status:'active'}] :
    table==='reminders' ? state.reminders.map(row=>({...row,schedule:schedules.find(item=>item.id===row.schedule_id)})) : [];
   if(table==='reminders' && operation==='read') {
    state.reminderReads++;state.activeReads++;state.peakReads=Math.max(state.peakReads,state.activeReads);
    return new Promise(done=>setTimeout(done,state.readDelay)).then(()=>{
     state.activeReads--;return {data,error:state.readError?{message:'Synthetic refresh failure'}:null};
    }).then(resolve,reject);
   }
   return Promise.resolve({data,error:null}).then(resolve,reject);
  }
 };return chain;
}
export const supabase = {
 from:query, rpc(name,args) {
  if(name==='get_doctor_patient_directory') return query('directory');
  if(name==='mark_medication_reminder_occurrence') {
   state.doseStatus=args.p_action;
   return Promise.resolve(state.fail?{data:null,error:{message:'Synthetic dose error'}}:{data:{status:args.p_action},error:null});
  }
  throw new Error('Unexpected offline RPC: '+name);
 },
 channel(name) {
  const channel={name,active:true,handlers:[],on(event,options,callback){this.handlers.push({options,callback});return this},
   subscribe(callback){this.statusCallback=callback;callback?.('SUBSCRIBED');return this}};
  state.channels.push(channel);return channel;
 },removeChannel(channel){channel.active=false},
 auth:{async getUser(){return {data:{user:{id:patientId,email:'synthetic@example.test'}},error:null}},
 async signInWithPassword(){return {error:state.fail?{message:'Invalid login credentials'}:null}},
 async updateUser(){state.authWrites++;return {error:null}}}
};`;

const fixture = `
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MemoryRouter} from 'react-router-dom';
import {_api,Icon} from '@iconify/react';
import '${root}/src/styles/appointment-ui-system.css';
import Doctor from '${root}/src/pages/doctor/Doctor_Reminder.jsx';
import Settings from '${root}/src/pages/patient/Patient_PWA_Settings.jsx';
import SuccessToast from '${root}/src/components/common/SuccessToast.jsx';
import {useSuccessToast} from '${root}/src/hooks/useSuccessToast.js';
import {state,supabase,patientId,reminderEvent,reconnect} from 'reminder-ui-mock';
_api.setFetch(async()=>({status:404}));
const NativeDate=Date;
let fixtureNow=NativeDate.parse('2026-10-06T17:00:00Z'),fixtureVisibility='visible';
globalThis.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[fixtureNow]))} static now(){return fixtureNow}};
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>fixtureVisibility});
const nativeSetInterval=window.setInterval.bind(window),nativeClearInterval=window.clearInterval.bind(window),statusTimers=new Map();
window.setInterval=(callback,delay,...args)=>{const id=nativeSetInterval(callback,delay,...args);if(delay===60000)statusTimers.set(id,callback);return id};
window.clearInterval=id=>{statusTimers.delete(id);nativeClearInterval(id)};
const tick=()=>statusTimers.forEach(callback=>callback());
const reports=[],failures=[]; let assertions=0;
const check=(condition,message)=>{assertions++;window.reminderUiProgress={assertions,message};if(!condition)failures.push(message)};
const pause=(ms=60)=>new Promise(resolve=>setTimeout(resolve,ms));
const $=selector=>document.querySelector(selector);
const buttons=(text,scope=document)=>[...scope.querySelectorAll('button')].filter(button=>button.textContent.trim()===text);
const change=(element,value)=>{
 const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);
 element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));
};
const root=createRoot($('#root'));
${appointmentFixtures.join("\n")}
function MedicationFixture() {
 const {toast,showSuccessToast,dismissToast}=useSuccessToast();
 const [medicationActionState,setMedicationActionState]=useState({key:'',action:''});
 const [medicationActionError,setMedicationActionError]=useState({key:'',message:''});
 const [medicationOccurrences,setMedicationOccurrences]=useState([{id:'dose',status:'notified'}]);
 const [skipTarget,setSkipTarget]=useState(null);
 const patientRecordId=patientId;
 const loadMedicationOccurrenceRows=async()=>{};
 ${medicationHandler}
 const item={occurrence:medicationOccurrences[0],matchKey:'dose-key',patientId};
 return <section className="pwa-main"><header className="pwa-topbar">Profile</header>
  <div className="pwa-medication-schedule-toolbar"><button id="taken" onClick={()=>handleMedicationOccurrenceAction(item,'taken')}>Taken</button>
   <button id="skipped" onClick={()=>handleMedicationOccurrenceAction(item,'skipped')}>Skipped</button></div>
  {skipTarget?<button id="confirm-skip" onClick={()=>handleMedicationOccurrenceAction(skipTarget,'skipped',{confirmed:true})}>Confirm skip</button>:null}
  <p role="alert">{medicationActionError.message}</p><p id="dose-state">{medicationOccurrences[0].status}</p>
  <span>{medicationActionState.action}</span><SuccessToast toast={toast} onDismiss={dismissToast}/>
 </section>;
}
let showLong;
function ToastFixture() {
 const {toast,showSuccessToast,dismissToast}=useSuccessToast(); showLong=showSuccessToast;
 return <main className="pwa-main"><header className="pwa-topbar">Profile</header>
 <button className="pwa-full-save" id="behind">Important action</button><SuccessToast toast={toast} onDismiss={dismissToast}/></main>;
}
async function render(component){
 flushSync(()=>root.render(<MemoryRouter>{component}</MemoryRouter>));await pause(100);
 // Wait for the actual loading state, rather than relying on CPU-dependent timing.
 for(let attempt=0;attempt<80 && $('.doctor-reminder-appointment-table .doctor-reminder-skeleton-row');attempt++) await pause();
 if($('.doctor-reminder-appointment-table .doctor-reminder-skeleton-row')) throw new Error('Offline appointment fixture did not finish loading');
}
const modal=()=>$('.doctor-reminder-form--appointment');
async function open(){buttons('Set Reminder',$('.doctor-reminder-page'))[0].click();await pause();change(modal().querySelector('select'),'appointment-0');await pause()}
const radio=(name,value)=>modal().querySelector('input[name="'+name+'"][value="'+value+'"]');
const dismiss=async()=>{const close=$('.mc-success-toast button');if(close){close.click();await pause(220)}};
const submit=async()=>{modal().requestSubmit();await pause(180)};
async function custom(date='2026-10-07',hour='02',minute='40',period='AM') {
 radio('reminderLeadTime','custom').click(); await pause();
 $('.mc-reminder-picker [data-date="'+date+'"]').click();await pause();
 const trigger=$('.mc-reminder-picker .appointment-time-picker__trigger');trigger.scrollIntoView({block:'center'});await pause();trigger.click();await pause();
 const popover=$('.mc-reminder-picker .appointment-time-picker__popover').getBoundingClientRect();
 check(popover.left>=0 && popover.right<=innerWidth && popover.top>=0 && popover.bottom<=innerHeight,'time selector fits viewport');
 for(const [label,value] of [['Hour',hour],['Minute',minute],['AM or PM',period]]) {change($('select[aria-label="'+label+'"]'),value);await pause()}
 buttons('Apply',$('.mc-reminder-picker'))[0].click();await pause();
}
try {
 await render(<Doctor doctorIdentity={{authUser:{id:'fixture-doctor'},loading:false}}/>);
 await open();
 check(!document.querySelector('input[type="datetime-local"]'),'native datetime-local removed');
 for(const preset of ['1hour','1day','3days','3weeks']) {
  radio('reminderLeadTime',preset).click();await pause();
  check(radio('reminderLeadTime',preset).checked,'preset selectable: '+preset);
 }
 await custom();
 check(!document.querySelector('input[type="datetime-local"]'),'Custom uses no native calendar control');
 check($('.mc-reminder-picker__preview').textContent.includes('2:40 AM'),'custom preview uses AM/PM');
 check(getComputedStyle($('.mc-reminder-picker .appointment-time-picker__trigger')).color==='rgb(39, 50, 68)','time value has readable dark text');
 check($('.doctor-reminder-preview').textContent.includes('8:30 AM'),'message preview retains appointment time');
 const day=$('.mc-reminder-picker [data-date="2026-10-07"]');
 const luminance=color=>{const rgb=color.match(/[0-9.]+/g).slice(0,3).map(value=>{const channel=Number(value)/255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4});return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722};
 const selectedStyle=getComputedStyle(day),foreground=luminance(selectedStyle.color),background=luminance(selectedStyle.backgroundColor);
 check((Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05)>=4.5,'selected date text meets 4.5:1 contrast');
 check($('.mc-reminder-picker [data-date="2026-10-06"]').disabled,'past date disabled');
 check($('.mc-reminder-picker [data-date="2026-10-10"]').disabled,'after-appointment date disabled');
 check(day.getAttribute('aria-current')==='date' && day.getAttribute('aria-pressed')==='true','today and selected states exposed');
 day.focus();day.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await pause();
 check(document.activeElement.dataset.date==='2026-10-08','calendar arrow key moves focus');
 const rect=$('.mc-reminder-picker').getBoundingClientRect(), dayRect=day.getBoundingClientRect();
 check(rect.left>=0 && rect.right<=innerWidth && rect.width>200,'calendar fits viewport');
 check(dayRect.height>=40 && (innerWidth>640 || dayRect.width>=39),'calendar touch targets: '+dayRect.width+' x '+dayRect.height);
 reports.push({stage:'calendar',width:innerWidth,calendarWidth:Math.round(rect.width),dayWidth:Math.round(dayRect.width)});
 check(document.documentElement.scrollWidth<=innerWidth,'modal has no page-wide horizontal overflow');
 await submit();
 const first=state.writes.at(-1)?.payload;
 check(first?.remind_at==='2026-10-06T18:40:00.000Z','custom YYYY-MM-DDTHH:mm reaches existing Manila save conversion');
 check(first?.repeat_mode==='none' && first?.status==='pending','No repeat and pending save preserved');
 check($('.mc-success-toast')?.textContent.includes('October 7, 2026 at 2:40 AM.'),'toast uses saved reminder time');
 check($('.mc-success-toast')?.textContent.includes('October 9, 2026 at 8:30 AM'),'toast separately labels appointment time');
 await Promise.allSettled($('.mc-success-toast').getAnimations().map(animation=>animation.finished));
 const savedToast=$('.mc-success-toast').getBoundingClientRect();
 const intersects=(first,second)=>first.left<second.right && first.right>second.left && first.top<second.bottom && first.bottom>second.top;
 check(Math.abs(savedToast.top-(innerWidth<=640?84:112))<1,'Doctor toast matches appointment notification top offset');
 check(savedToast.left>=0 && savedToast.right<=innerWidth && getComputedStyle($('.mc-success-toast')).right!=='auto','Doctor toast remains upper-right within viewport');
 check(!intersects(savedToast,$('.doctor-medication-card').getBoundingClientRect()),'Doctor toast avoids Medication Reminder card');
 check(!intersects(savedToast,$('.doctor-reminder-appointment-table').getBoundingClientRect()),'Doctor toast avoids primary appointment table');
 check(!modal(),'successful save closes modal');
 buttons('Upcoming',$('.doctor-reminder-page'))[0].click();await pause();
 check($('.doctor-reminder-page').textContent.includes('Scheduled'),'appointment reminder list refreshes');
 check(!$('.doctor-reminder-page').textContent.includes('Appointment reminder saved successfully.'),'no duplicate inline success');
 await dismiss();
 const mark=()=>document.querySelector('.doctor-reminder-appointment-row:not(.doctor-reminder-skeleton-row) mark')?.textContent;
 const serverStatus=status=>{
  state.reminders[0]={...state.reminders[0],status,sent_at:status==='sent'?new Date().toISOString():null};return state.reminders[0];
 };
 fixtureNow=NativeDate.parse('2026-10-06T18:41:00Z');tick();await pause(150);
 check(mark()==='Due','pending reminder becomes DUE after trigger time');
 const writesBeforeRefresh=state.writes.length;
 reminderEvent(serverStatus('sent'));await pause(150);
 check(mark()==='Sent','realtime reminders UPDATE changes DUE to SENT without navigation');
 const pending=async()=>{reminderEvent(serverStatus('pending'));await pause(150);check(mark()==='Due','fixture restores DUE before missed-event recovery')};
 await pending();serverStatus('sent');reconnect();await pause(150);
 check(mark()==='Sent','subscription/reconnection refresh recovers missed SENT event');
 await pending();serverStatus('sent');const readsBeforeTick=state.reminderReads;tick();await pause(150);
 check(mark()==='Sent' && state.reminderReads===readsBeforeTick+1,'existing minute tick reloads database status after missed realtime event');
 await pending();serverStatus('sent');window.dispatchEvent(new Event('focus'));await pause(150);
 check(mark()==='Sent','focus refresh recovers SENT');
 await pending();serverStatus('sent');fixtureVisibility='hidden';const readsBeforeHidden=state.reminderReads;
 document.dispatchEvent(new Event('visibilitychange'));tick();await pause(100);
 check(state.reminderReads===readsBeforeHidden && mark()==='Due','hidden tab avoids polling');
 fixtureVisibility='visible';document.dispatchEvent(new Event('visibilitychange'));await pause(150);
 check(mark()==='Sent','visible tab resumes with fresh SENT state');
 state.readError=true;tick();await pause(150);
 check(mark()==='Unavailable' && $('.doctor-reminder-page').textContent.includes('Synthetic refresh failure'),'refresh failure remains visible');
 state.readError=false;tick();await pause(150);
 check(mark()==='Sent','later refresh clears error and restores SENT');
 await pending();state.readDelay=100;state.peakReads=0;
 const beforeBurst=state.reminderReads;reminderEvent(state.reminders[0]);await pause(20);
 const sentRow=serverStatus('sent');reminderEvent(sentRow);reminderEvent(sentRow);reconnect();await pause(280);
 check(mark()==='Sent' && state.peakReads===1 && state.reminderReads===beforeBurst+2,'coalesced event burst finishes with newest SENT state and no parallel requests');state.readDelay=0;
 check(state.writes.length===writesBeforeRefresh,'all status refreshes are read-only');
 check(statusTimers.size===1,'uses one existing minute timer');
 fixtureNow=NativeDate.parse('2026-10-06T17:00:00Z');tick();await pause(100);
 await open();
 check($('#doctor-reminder-form-title').textContent==='Edit Reminder','saved reminder reopens for edit');
 check($('.mc-reminder-picker__preview').textContent.includes('2:40 AM'),'edit restores saved custom datetime');
 await custom('2026-10-07','12','30','AM');const beforePast=state.writes.length;await submit();
 check(state.writes.length===beforePast && modal().textContent.includes('future'),'past time blocks save');
 await custom('2026-10-09','08','21','AM');
 const writes=state.writes.length;await submit();
 check(state.writes.length===writes && !!modal(),'nine-minute lead rejected without write');
 check(modal().textContent.includes('at least 10 minutes'),'validation error remains inline');
 await custom('2026-10-09','08','20','AM');await submit();
 check(state.writes.length===writes+1,'exact ten-minute boundary saves');
 check($('.mc-success-toast strong')?.textContent==='Reminder updated','edit uses update toast');
 check(state.writes.at(-1)?.operation==='update','edit retains existing update path');await dismiss();
 for(const [mode,preset] of [['daily','3days'],['hourly','1day']]) {
  await open();change(modal().querySelector('select'),'appointment-1');await pause();
  radio('reminderLeadTime',preset).click();radio('repeatReminder',mode).click();await pause();await submit();
  check(state.writes.at(-1)?.payload.repeat_mode===mode,'repeat preserved: '+mode);
  await dismiss();
 }
 for(const [preset,hours] of [['1hour',1],['1day',24],['3days',72],['3weeks',504]]) {
  await open();change(modal().querySelector('select'),'appointment-1');await pause();
  radio('reminderLeadTime',preset).click();radio('repeatReminder','none').click();await pause();await submit();
  check(NativeDate.parse('2026-11-09T00:30:00Z')-NativeDate.parse(state.writes.at(-1)?.payload.remind_at)===hours*3600000,'preset saved with original offset: '+preset);await dismiss();
 }
 await open();change(modal().querySelector('select'),'appointment-1');await pause();radio('reminderLeadTime','custom').click();await pause();
 $('.mc-reminder-picker button[aria-label="Next month"]').click();await pause();
 check($('.mc-reminder-picker header strong').textContent==='November 2026','next month works within appointment boundary');
 check($('.mc-reminder-picker [data-date="2026-11-10"]').disabled,'next-month unavailable days disabled');
 $('.mc-reminder-picker button[aria-label="Previous month"]').click();await pause();
 check($('.mc-reminder-picker header strong').textContent==='October 2026','previous month returns to clinic current month');
 modal().querySelector('footer button[type="button"]').click();await pause();
 await open();radio('reminderTargetMode','multiple').click();await pause();
 check(radio('reminderLeadTime','custom').disabled,'bulk Custom remains disabled');
 check(modal().textContent.includes('Only appointments without a configured reminder.'),'bulk exclusion guidance preserved');
 modal().querySelector('footer button[type="button"]').click();await pause();
 // Reset only synthetic backend rows, then remount to exercise existing bulk save.
 state.reminders=[];await render(<div/>);await render(<Doctor doctorIdentity={{authUser:{id:'fixture-bulk'},loading:false}}/>);
 buttons('Set Reminder',$('.doctor-reminder-page'))[0].click();await pause();
 radio('reminderTargetMode','all_without').click();radio('reminderLeadTime','1day').click();await pause();
 const beforeBulk=state.writes.length;await submit();
 check(state.writes.length===beforeBulk+2,'all-missing saves both eligible reminders');
 check($('.mc-success-toast')?.textContent.includes('2 appointment reminders scheduled successfully.'),'bulk success count retained');await dismiss();
 state.reminders=[];await render(<div/>);await render(<Doctor doctorIdentity={{authUser:{id:'fixture-partial'},loading:false}}/>);
 buttons('Set Reminder',$('.doctor-reminder-page'))[0].click();await pause();radio('reminderTargetMode','multiple').click();await pause();
 modal().querySelector('.doctor-reminder-bulk-select-all input').click();radio('reminderLeadTime','1day').click();await pause();
 state.failSchedule='appointment-1';const beforePartial=state.writes.length;await submit();
 check(state.writes.length===beforePartial+1 && !!modal(),'bulk partial failure keeps modal and saves successful appointment');
 check(modal().textContent.includes('failed') && !$('.mc-success-toast'),'partial failure remains inline without false all-success');state.failSchedule='';
 await render(<Settings profile={{displayName:'Synthetic Patient'}}/>);
 check(statusTimers.size===0 && !state.channels.some(channel=>channel.active && channel.name.startsWith('doctor-reminder-appointment-data-')),'Doctor unmount removes status timer and realtime channel');
 const readsAfterUnmount=state.reminderReads;window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));await pause(100);
 check(state.reminderReads===readsAfterUnmount,'Doctor unmount removes focus and visibility refresh listeners');
 $('#settings-tab-password').click();await pause();
 const inputs=[...document.querySelectorAll('.pwa-password-card input')];
 for(const [index,value] of ['OldPass123!','NewPass1234!@','NewPass1234!@'].entries()){change(inputs[index],value);await pause()}
 $('.pwa-security-grid').requestSubmit();await pause(120);
 check(state.authWrites===1 && $('.mc-success-toast')?.textContent.includes('Password updated successfully.'),'Patient password feedback floats after actual handler succeeds');
 check(!$('.pwa-settings-form-message'),'password success has no inline duplicate');await dismiss();
 for(const [index,value] of ['WrongPass123!','OtherPass123!','OtherPass123!'].entries()){change(inputs[index],value);await pause()}
 state.fail=true;$('.pwa-security-grid').requestSubmit();await pause(120);
 check($('.pwa-settings-form-message[role="alert"]')?.textContent.includes('Current Password is incorrect.'),'password error remains persistent and inline');state.fail=false;
 await render(<MedicationFixture/>);$('#taken').click();await pause();
 check($('#dose-state').textContent==='taken' && $('.mc-success-toast')?.textContent.includes('recorded as taken.'),'Patient Taken action and toast preserved');await dismiss();
 $('#skipped').click();await pause();check(!!$('#confirm-skip') && !$('.mc-success-toast'),'Skip confirmation precedes success');
 $('#confirm-skip').click();await pause();
 check($('#dose-state').textContent==='skipped' && $('.mc-success-toast')?.textContent.includes('recorded as skipped.'),'Patient Skipped action and toast preserved');await dismiss();
 state.fail=true;$('#taken').click();await pause();
 check($('[role="alert"]').textContent.includes('Unable to update this reminder.') && !$('.mc-success-toast'),'medication error stays inline without false success');state.fail=false;
 for(const Component of [doctorAppointmentToastFixture,staffAppointmentToastFixture]) {
  await render(<Component/>);$('#existing-toast').click();await pause(220);
  const existing=$('.appointment-success-toast'),box=existing.getBoundingClientRect();
  check(existing.querySelector('.appointment-success-toast__copy span').textContent==='Appointment marked as No Show.' && existing.getAttribute('aria-live')==='polite','existing appointment toast still renders');
  check(getComputedStyle(existing).position==='fixed' && box.left>=0 && box.right<=innerWidth,'existing appointment toast retains fixed responsive placement');
  await pause(5050);check(!$('.appointment-success-toast'),'appointment five-second dismissal');
 }
 await render(<ToastFixture/>);$('#behind').focus();const focused=document.activeElement;
 showLong({title:'Reminder scheduled',message:'Synthetic Very Long Patient Name '.repeat(5)+'will receive a reminder on October 7, 2026 at 2:40 AM.',details:['Appointment: October 9, 2026 at 8:30 AM','Repeat: No repeat']});await pause(240);
 const toast=$('.mc-success-toast'),toastRect=toast.getBoundingClientRect(),action=$('#behind').getBoundingClientRect();
 check(toastRect.left>=0 && toastRect.right<=innerWidth && toastRect.top>=0 && toastRect.bottom<=innerHeight,'long toast fits viewport');
 check(toast.scrollWidth<=toast.clientWidth,'long names wrap without toast overflow');
 check(!(toastRect.left<action.right && toastRect.right>action.left && toastRect.top<action.bottom && toastRect.bottom>action.top),'toast does not cover important action');
 check(document.activeElement===focused,'toast does not steal focus');
 check(toast.getAttribute('role')==='status' && toast.getAttribute('aria-live')==='polite','toast polite status semantics');
 check(getComputedStyle(toast).animationName===(matchMedia('(prefers-reduced-motion: reduce)').matches?'none':'mc-success-toast-in'),'toast respects reduced motion');
 check(getComputedStyle(toast).pointerEvents==='none' && getComputedStyle(toast.querySelector('button')).pointerEvents==='auto','toast lets clicks through while close remains operable');
 toast.querySelector('button').focus();check(document.activeElement===toast.querySelector('button'),'close button keyboard reachable');
 const menu=document.createElement('div');menu.className='doctor-profile-dropdown';
 menu.style.cssText='position:fixed;right:12px;top:84px;width:300px;height:310px;';document.body.append(menu);await pause();
 const relocated=toast.getBoundingClientRect(),menuRect=menu.getBoundingClientRect();
 check(!(relocated.left<menuRect.right && relocated.right>menuRect.left && relocated.top<menuRect.bottom && relocated.bottom>menuRect.top),'open global profile menu cannot be covered by toast');menu.remove();
 reports.push({width:innerWidth,calendarWidth:Math.round(rect.width),dayWidth:Math.round(dayRect.width),toastWidth:Math.round(toastRect.width)});
 await pause(5050);check(!$('.mc-success-toast'),'toast auto-dismisses around five seconds');
 showLong({title:'Updated',message:'Manual close fixture'});await pause();await dismiss();check(!$('.mc-success-toast'),'manual dismissal includes exit cleanup');
 window.inspectReminderPicker=async()=>{
  await render(<Doctor doctorIdentity={{authUser:{id:'fixture-inspection'},loading:false}}/>);await open();await custom();
  $('.mc-reminder-picker').scrollIntoView({block:'start'});await pause(250);
 };
 window.inspectReminderToast=async()=>{await submit();await pause(220)};
 window.reminderUiResult={assertions,failures,reports};
} catch(error) {window.reminderUiResult={assertions,failures:[...failures,error.stack,modal()?.textContent?.slice(-500)],reports}}
`;

const result = await build({ root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-reminder-ui", enforce: "pre",
    resolveId(id) {
      if (id.endsWith("reminder-ui-test.jsx")) return "\0reminder-ui-test.jsx";
      if (id === "reminder-ui-mock" || /\/supabaseClient(?:\.js)?$/.test(id)) return "\0reminder-ui-mock.js";
      if (/\/useAuthenticatedDoctor(?:\.js)?$/.test(id)) return "\0reminder-ui-auth.js";
      if (/\/PatientPushNotificationSettings(?:\.jsx)?$/.test(id)) return "\0reminder-ui-push.jsx";
    },
    load(id) {
      if (id === "\0reminder-ui-test.jsx") return fixture;
      if (id === "\0reminder-ui-mock.js") return mock;
      if (id === "\0reminder-ui-auth.js") return "export async function loadAuthenticatedDoctor(){return {authUser:{id:'fixture-doctor'}}}";
      if (id === "\0reminder-ui-push.jsx") return "export default function PushSettings(){return null}";
    },
  }, react()], build: { write: false, minify: false, lib: { entry: "reminder-ui-test.jsx", formats: ["es"] } } });
const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
const code = outputs.find(output => output.type === "chunk").code.replaceAll("</script", "<\\/script");
const css = (await readFile(join(root, "src/styles/patient-PWA.css"), "utf8")) + "\n" +
  outputs.filter(output => output.type === "asset" && output.fileName.endsWith(".css")).map(output => output.source).join("\n");
const temporary = await mkdtemp(join(tmpdir(), "maternal-reminder-ui-"));
const html = join(temporary, "fixture.html");
await writeFile(html, `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.replace(/@import[^;]+;/g, "")}
body{margin:0}.doctor-reminder-page{box-sizing:border-box;padding:24px;min-height:100vh}.pwa-main{padding:24px}.pwa-topbar{height:60px}.pwa-full-save{margin-top:20px}
</style><div id="root"></div><script type="module">${code}</script>`);
const candidates = process.env.HEADLESS_BROWSER ? [process.env.HEADLESS_BROWSER] : [
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome",
];
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch { /* Try installed browsers. */ } }
assert.ok(executable, "Set HEADLESS_BROWSER to an installed Chrome/Chromium executable");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(temporary, "browser-profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket, cdp;
try {
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(temporary, "browser-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await pause(); }
  }
  assert.ok(port, "Temporary offline Chrome must start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`Browser command timed out: ${method}`)); }, 5000).unref();
  });
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  let total = 0, failed = 0;
  const requestedWidths = process.argv.slice(2).map(Number);
  for (const width of requestedWidths.length ? requestedWidths : [1440, 1180, 1024, 900, 768, 375]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: width === 375 ? "reduce" : "no-preference" }] });
    await cdp("Page.navigate", { url: pathToFileURL(html).href });
    let observation;
    for (let attempt = 0; attempt < 500 && !observation; attempt++) {
      await pause(); observation = (await cdp("Runtime.evaluate", { expression: "window.reminderUiResult", returnByValue: true })).result.value;
    }
    if (!observation) console.error((await cdp("Runtime.evaluate", { expression: "({progress:window.reminderUiProgress,body:document.body.textContent.slice(-600)})", returnByValue: true })).result.value);
    assert.ok(observation, "Browser fixture must complete");
    total += observation.assertions; failed += observation.failures.length;
    console.log(`${width}px: ${observation.assertions} assertions, ${observation.failures.length} failures; ${JSON.stringify(observation.reports)}`);
    observation.failures.forEach(failure => console.error(failure));
    if (!observation.failures.length && [1440, 375].includes(width)) {
      await cdp("Runtime.evaluate", { expression: "window.inspectReminderPicker()", awaitPromise: true });
      const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(join(temporary, `picker-${width}.png`), Buffer.from(screenshot.data, "base64"));
      console.log(`Picker screenshot: ${join(temporary, `picker-${width}.png`)}`);
      await cdp("Runtime.evaluate", { expression: "window.inspectReminderToast()", awaitPromise: true });
      const toastScreenshot = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(join(temporary, `toast-${width}.png`), Buffer.from(toastScreenshot.data, "base64"));
    }
  }
  console.log(`Browser total: ${total} assertions, ${failed} failures. All backend/auth/push requests mocked; HTTP(S) blocked.`);
  assert.equal(failed, 0, "Reminder UI regressions must pass");
} finally {
  if (cdp) await cdp("Browser.close").catch(() => browser.kill()); else browser.kill();
  socket?.close();
}
