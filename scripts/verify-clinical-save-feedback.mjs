// Offline four clinical workflows: real forms/router/destination pages; synthetic backend only.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
const root=fileURLToPath(new URL('../',import.meta.url));let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRouter,useLocation,useNavigate} from 'react-router-dom';
import {DoctorAppointmentsContent} from '__ROOT__/src/pages/doctor/Doctor_Appointments.jsx';
import {StaffAppointmentsContent} from '__ROOT__/src/pages/staff/Staff_Appointments.jsx';
import '__ROOT__/src/styles/doctor-dashboard.css';import '__ROOT__/src/styles/staff-dashboard.css';
window.test={writes:[],errors:[],case:0,mode:'ok',hold:false,type:'initial',syncFail:false,record:null,intake:null};
window.addEventListener('error',e=>window.test.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.test.errors.push(String(e.reason)));
const vitals={height:'160',weight:'60',bloodPressure:'120/80',temperature:'36.7',respiratoryRate:'18',oxygenSaturation:'98',fetalHeartRate:'145',gestationalAge:'27',expectedDeliveryDate:'2027-01-06',visitDate:'2026-10-19',visitTime:'09:00',pregnancyStatus:'Low Risk'};
window.test.valid=vitals;
function App(){const location=useLocation(),navigate=useNavigate(),staff=location.pathname.startsWith('/staff');window.test.location=location;window.test.navigate=navigate;
window.test.start=(role,type,mode='ok')=>{Object.assign(window.test,{type,mode,record:null,intake:null,syncFail:false,hold:false});window.test.appointmentId='bbbbbbbb-bbbb-4bbb-8bbb-'+String(++window.test.case).padStart(12,'0');navigate('/'+role+'/appointments/'+window.test.appointmentId+'/'+(type==='initial'?'initial-visit':'follow-up'));};
return <div className={'doctor-dashboard'+(staff?' staff-dashboard-shell':'')}><aside className='doctor-sidebar'/><main className='doctor-main'><div className='doctor-content'>
{staff?<StaffAppointmentsContent staffUserId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' requestNotifications={{identity:'synthetic-session',refresh:async()=>{},requests:[]}}/>:<DoctorAppointmentsContent embedded doctorIdentity={{authUser:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},loading:false,doctorDisplayName:'Synthetic Doctor'}}/>}
</div><div aria-hidden='true' style={{height:1200}}/></main></div>;}
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`.replaceAll("__ROOT__",root.replaceAll("\\","/"));
const mock=`
const patient={id:'11111111-1111-4111-8111-111111111111',patient_id:'SYNTHETIC-001',full_name:'Synthetic Patient',expected_delivery_date:'2027-01-06',gestational_age:'27',risk_level:'Low Risk'};
const result=data=>({data,error:null});
function schedule(){return {id:window.test.appointmentId||'bbbbbbbb-bbbb-4bbb-8bbb-000000000000',maternal_appointment_id:'SYNTHETIC-001',patient_id:patient.id,doctor_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',patient_name:patient.full_name,doctor_name:'Synthetic Doctor',title:'Prenatal Checkup',start_time:'2026-10-19T01:00:00Z',end_time:'2026-10-19T01:30:00Z',status:window.test.record?'completed':'checked_in'};}
function query(table){let single=false;const q={select(){return q;},eq(){return q;},neq(){return q;},order(){return q;},limit(){return q;},in(){return q;},gte(){return q;},lte(){return q;},lt(){return q;},is(){return q;},or(){return q;},ilike(){return q;},abortSignal(){return q;},range(){return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},then(resolve,reject){let data=[];
if(table==='schedule')data=[schedule()];if(table==='patients'||table==='directory')data=[patient];
if(table==='medical_records')data=window.test.record?[window.test.record]:[];
if(table==='patient_obstetric_history')data=[{id:'synthetic-history',patient_id:patient.id,expected_delivery_date:'2027-01-06',gravida:1,para:0,full_term:0,preterm:0,abortion_miscarriage:0,living_children:0}];
return Promise.resolve(result(single?data[0]||null:data)).then(resolve,reject);}};return q;}
export const supabase={from:query,rpc(name,args){
if(name==='get_appointment_visit_form_type')return Promise.resolve(result({visit_form_type:window.test.type,appointment_status:'checked_in'}));
if(name==='get_doctor_patient_directory'||name==='get_staff_patient_directory')return query('directory');
if(name==='get_staff_followup_baseline')return Promise.resolve(result(null));
if(name==='get_staff_visit_intake')return Promise.resolve(result(window.test.intake||(location.pathname.startsWith('/doctor')?{id:'prior-intake',intake_data:window.test.valid}:null)));
if(name==='get_operational_appointment_policy')return Promise.resolve(result({timezone:'Asia/Manila',clinic_opening_time:'08:00',clinic_closing_time:'17:00',default_appointment_duration_minutes:30}));
if(name==='save_staff_visit_intake'||name==='save_appointment_visit_record'){
window.test.writes.push({name,args});const respond=()=>{
if(window.test.mode==='network')return Promise.reject(Error('Synthetic connection failure'));
if(window.test.mode==='fail')return Promise.resolve({data:null,error:{code:'42501',message:'Synthetic save rejected'}});
if(name==='save_staff_visit_intake')window.test.intake={id:'synthetic-intake',patient_id:patient.id,appointment_id:args.p_appointment_id,visit_type:args.p_visit_form_type,status:'staff_completed',intake_data:args.p_intake_data};
else window.test.record={id:'synthetic-record',patient_id:patient.id,schedule_id:args.p_appointment_id,doctor_id:schedule().doctor_id,type:args.p_visit_form_type==='initial'?'Initial Visit':'Follow-Up Visit',form_data:args.p_form_data};
if(window.test.mode==='mismatch'&&window.test.intake)window.test.intake.patient_id='foreign-patient';
return Promise.resolve(result(window.test.mode==='no-receipt'?null:name==='save_staff_visit_intake'?window.test.intake:window.test.record));};
return window.test.hold?new Promise(done=>window.test.release=()=>done(respond())):respond();}
if(name==='sync_doctor_visit_pregnancy_state'){window.test.writes.push({name,args});return Promise.resolve(window.test.syncFail?{data:null,error:{message:'Synthetic pregnancy summary sync rejected'}}:result(null));}
if(/^(save|create|accept|decline|send|update|record)_/.test(name))throw Error('Forbidden fixture RPC: '+name);
return Promise.resolve(result([]));},
channel(){const q={on(){return q;},subscribe(){return q;}};return q;},removeChannel(){return Promise.resolve('ok');},auth:{getUser:async()=>result({user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}})}};`;
const bundle=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
name:'offline-clinical-save',enforce:'pre',resolveId(id){if(id.endsWith('clinical-save-fixture.jsx'))return '\0clinical-save-fixture.jsx';
if(/\/supabaseClient(?:\.js)?$/.test(id))return '\0synthetic-client';if(id.endsWith('/useAuthenticatedDoctor'))return '\0synthetic-doctor';
if(id.endsWith('/useSendPatientNotification'))return '\0synthetic-patient-notifications';
if(/\/(automaticAppointmentNotification|appointmentSms)(?:\.js)?$/.test(id))return '\0forbidden-delivery';if(id==='@iconify/react')return '\0fixture-icon';},
load(id){if(id==='\0clinical-save-fixture.jsx')return fixture;if(id==='\0synthetic-client')return mock;
if(id==='\0synthetic-doctor')return 'export async function loadAuthenticatedDoctor(){return {authUser:{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}}';
if(id==='\0synthetic-patient-notifications')return 'export function useSendPatientNotification(){return {sendPatientNotification(){throw Error("Forbidden notification")}}}';
if(id==='\0forbidden-delivery')return 'export const appointmentSmsEvents={confirmed:"confirmed"};export function requestAppointmentSms(){throw Error("Forbidden SMS")};export function sendAutomaticAppointmentNotification(){throw Error("Forbidden delivery")}';
if(id==='\0fixture-icon')return 'import React from "react";export function Icon(){return React.createElement("svg",{"aria-hidden":true,width:18,height:18})}';},
transform(code,id){const path=id.replaceAll('\\','/');
if(path.endsWith('/Staff_Appointments.jsx'))return code+'\nexport {StaffAppointmentsContent};';
if(path.endsWith('/AppointmentVisitForm.jsx'))return code.replace('  if (loading) {','  window.test.fill=values=>setForm(current=>({...current,...values}));window.test.save=saveRecord;\n  if (loading) {');
if(path.endsWith('/StaffPreConsultationForm.jsx'))return code.replace('  if (loading) {','  window.test.fill=values=>setForm(current=>({...current,...values}));window.test.save=saveForm;\n  if (loading) {');
}}],build:{write:false,minify:false,lib:{entry:'clinical-save-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(bundle)?bundle:[bundle]).flatMap(x=>x.output);
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial;padding:12px}${outputs.filter(x=>x.fileName.endsWith('.css')).map(x=>x.source).join('\n').replace(/@import\s+url\([^)]*\)\s*;/g,'')}</style><div id="root"></div><script type="module">${outputs.find(x=>x.type==='chunk').code.replaceAll('</script','<\\/script')}</script>`;
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const temp=await mkdtemp(join(tmpdir(),'maternal-clinical-save-feedback-'));let browser,socket,cdpForFailure;
const pause=(ms=50)=>new Promise(r=>setTimeout(r,ms));
try{
 let executable;for(const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome']){try{await access(p);executable=p;break;}catch{/* Try the next platform's browser path; availability is asserted below. */}}
 assert.ok(executable,'Installed browser');browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${join(temp,'profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<120&&!port;i++){try{port=(await readFile(join(temp,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await pause();}}
 assert.ok(port,'Browser ready');const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let id=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),5000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});
 cdpForFailure=cdp;
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async(expression,label)=>{let result;for(let i=0;i<100;i++){result=await evaluate(expression);if(result)break;await pause();}if(!result)console.error(await evaluate("JSON.stringify({errors:window.test?.errors,close:(()=>{const e=document.querySelector('.doctor-reminder-dialog-close');return e?{rect:e.getBoundingClientRect().toJSON(),width:getComputedStyle(e).width,height:getComputedStyle(e).height,position:getComputedStyle(e).position}:null})(),text:document.body.textContent.slice(-300)})"));check(result,label);};
 const screenshot=async name=>{await pause(350);const r=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(temp,name+'.png'),Buffer.from(r.data,'base64'));};
 await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*']});
 await cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/doctor/appointments`});await cdp('Page.bringToFront');
 await until('!!window.test?.start','Real Router fixture ready');
 const messages={staff:{initial:'Initial assessment saved successfully.',follow_up:'Follow-up assessment saved successfully.'},doctor:{initial:'Initial visit record saved successfully.',follow_up:'Follow-up visit record saved successfully.'}};
 const formSelector=role=>role==='staff'?'.staff-preconsult-page':'.appointment-visit-page';
 const fill=async()=>{await evaluate("window.test.fill({...window.test.valid,chiefComplaint:'Synthetic complaint',diagnosis:'Synthetic diagnosis',assessment:'Synthetic assessment',doctorOrder:'Synthetic order',treatmentPlan:'Synthetic plan',fundalHeight:'27',estimatedFetalWeight:'1.0',fetalMovement:'Active / Present',babyPosition:'Cephalic',pregnancyType:'Singleton',riskLevel:'Low Risk',smokingStatus:'Never',alcoholIntake:'Never',drugUse:'No',physicalActivity:'Moderate',diet:'Balanced'})");await pause();};
 const start=async(role,type,mode='ok')=>{
  await evaluate(`window.test.start('${role}','${type}','${mode}')`);await pause(150);
  await until(`!!document.querySelector('${formSelector(role)}')&&!document.querySelector('button[disabled][type=submit]')&&!document.body.innerText.includes('Loading visit information')&&!document.body.innerText.includes('Loading pre-consultation')`,role+' '+type+': form ready');
  await fill();
  await evaluate("document.querySelector('.doctor-main').scrollTo({top:650,behavior:'instant'});window.scrollTo({top:650,behavior:'instant'})");await pause();
 };
 const saveCalls=()=>evaluate("window.test.writes.filter(w=>['save_staff_visit_intake','save_appointment_visit_record'].includes(w.name)).length");
 for(const width of [320,390,768,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  for(const role of ['staff','doctor'])for(const type of ['initial','follow_up']){
   const label=width+' '+role+' '+type;
   await start(role,type,'fail');const before=await saveCalls();
   await evaluate('window.test.hold=true;window.test.save();window.test.save()');await pause();
   check(await saveCalls()===before+1,label+': one mutation for rapid submissions');
   check(await evaluate("document.body.innerText.includes('Saving')"),label+': Saving state');
   check(await evaluate("window.test.location.pathname.includes(window.test.appointmentId)&&!document.querySelector('.appointment-success-toast[role=status]')"),label+': pending result does not navigate or announce success');
   await evaluate('window.test.release()');await until("!!document.querySelector('.appointment-success-toast[role=alert]')",label+': visible backend error');
   check(await evaluate("window.test.location.pathname.includes(window.test.appointmentId)&&!document.querySelector('.appointment-success-toast[role=status]')&&(window.scrollY>0||document.querySelector('.doctor-main').scrollTop>0)"),label+': failure stays on scrolled form');
   check(await evaluate("(()=>{const e=document.querySelector('.appointment-success-toast[role=alert]'),r=e.getBoundingClientRect();return e.textContent.includes('Synthetic save rejected')&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()"),label+': error feedback visible in viewport');
   await evaluate("document.querySelector('.appointment-success-toast__close').click()");
   await until("!document.querySelector('.appointment-success-toast[role=alert]')",label+': manual error dismissal');
   await evaluate("window.test.fill({weight:'abc60'})");await pause();const invalidBefore=await saveCalls();await evaluate('window.test.save()');await pause();
   check(await saveCalls()===invalidBefore,label+': validation prevents all mutations');
   check(await evaluate("window.test.location.pathname.includes(window.test.appointmentId)&&!document.querySelector('.appointment-success-toast[role=status]')"),label+': validation cannot navigate or claim success');
   await start(role,type);const successBefore=await saveCalls();
   check(await evaluate("window.scrollY>0||document.querySelector('.doctor-main').scrollTop>0"),label+': retained scroll reproduced');
   await evaluate('window.test.hold=true;window.test.save();window.test.save()');await pause();
   check(await saveCalls()===successBefore+1,label+': successful submission sends once');
   check(await evaluate("window.test.location.pathname.includes(window.test.appointmentId)"),label+': delayed success waits for receipt');
   await evaluate('window.test.release()');await until(`window.test.location.pathname==='/${role}/appointments'&&!!document.querySelector('.appointment-success-toast[role=status]')`,label+': destination toast survives real navigation');
   await pause(450);
   check(await evaluate(`document.querySelector('.appointment-success-toast[role=status]').textContent.includes(${JSON.stringify(messages[role][type])})`),label+': exact success message');
   check(await evaluate("window.scrollY===0&&document.querySelector('.doctor-main').scrollTop===0"),label+': correct desktop/mobile scroll owner reset');
   check(await evaluate("(()=>{const h=document.querySelector('.appointment-ui-header'),r=h.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),label+': Appointments heading visible');
   check(await evaluate("(()=>{const e=document.querySelector('.appointment-success-toast[role=status]'),r=e.getBoundingClientRect();return e.getAttribute('aria-live')==='polite'&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()"),label+': accessible success toast remains in viewport');
   check(await evaluate("!window.test.location.state?.clinicalSave"),label+': consumed feedback cannot replay');
   check(await evaluate(`(()=>{const w=window.test.writes.filter(w=>w.name==='${role==='staff'?'save_staff_visit_intake':'save_appointment_visit_record'}').at(-1);return w.args.p_appointment_id===window.test.appointmentId&&w.args.p_visit_form_type==='${type}'&&${role==='staff'?"window.test.record===null&&window.test.intake.status==='staff_completed'":"window.test.record.schedule_id===window.test.appointmentId&&window.test.record.form_data.recordStatus==='completed'"}})()`),label+': same record association and completion contract');
   if([390,1366].includes(width))await screenshot(role+'-'+type+'-'+width);
   if(width===1366&&role==='doctor'&&type==='follow_up'){
    await pause(3200);check(await evaluate("!!document.querySelector('.appointment-success-toast[role=status]')"),'Success remains visible for at least four seconds');
    await until("!document.querySelector('.appointment-success-toast[role=status]')",'Success automatically dismisses after about five seconds');
   }else{await evaluate("document.querySelector('.appointment-success-toast__close').click()");await until("!document.querySelector('.appointment-success-toast[role=status]')",label+': manual success dismissal');}
  }
  console.log(width+'px: all four clinical saves, failures, validation and scroll checks passed');
 }
 for(const role of ['staff','doctor']){
  await evaluate(`window.test.navigate('/${role}/appointments')`);await pause(150);
  await until(`!!document.querySelector('.${role}-appointments-page .appointment-ui-search input')`,role+': search available');
  await evaluate(`(()=>{const input=document.querySelector('.${role}-appointments-page .appointment-ui-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Synthetic');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause();
  await start(role,'initial');await evaluate('window.test.save()');
  await until(`window.test.location.pathname==='/${role}/appointments'`,role+': search preservation return');
  check(await evaluate(`document.querySelector('.${role}-appointments-page .appointment-ui-search input').value==='Synthetic'`),role+': post-save handoff preserves search state');
  await evaluate("document.querySelector('.appointment-success-toast__close').click()");
  await evaluate("document.querySelector('.doctor-main').scrollTo({top:500,behavior:'instant'});window.scrollTo({top:500,behavior:'instant'})");
  await evaluate(`window.test.navigate('/${role}/appointments',{replace:true,state:{preserved:'context'}})`);await pause(100);
  check(await evaluate("!document.querySelector('.appointment-success-toast[role=status]')&&(window.scrollY>0||document.querySelector('.doctor-main').scrollTop>0)&&window.test.location.state.preserved==='context'"),role+': ordinary navigation neither resets scrolling nor replays save feedback');
 }
 for(const role of ['staff','doctor'])for(const type of ['initial','follow_up']){
  for(const mode of ['no-receipt','network',...(role==='staff'?['mismatch']:[])]){
   await start(role,type,mode);const before=await saveCalls();await evaluate('window.test.save()');await pause(150);
   if(role==='staff'&&mode==='no-receipt'){
    await until("window.test.location.pathname==='/staff/appointments'",type+': Staff existing readback confirms inconclusive mutation');
    check(await saveCalls()===before+1,'Staff readback never repeats the save');
    await evaluate("document.querySelector('.appointment-success-toast__close').click()");
   }else{
    await until("!!document.querySelector('.appointment-success-toast[role=alert]')",role+' '+type+' '+mode+': accurate failure');
    check(await saveCalls()===before+1,role+' '+mode+': no blind retry');
    check(await evaluate("window.test.location.pathname.includes(window.test.appointmentId)&&!document.querySelector('.appointment-success-toast[role=status]')"),role+' '+mode+': no false success or navigation');
   }
  }
 }
 for(const type of ['initial','follow_up']){
  await start('doctor',type);await evaluate('window.test.syncFail=true;window.test.save()');await until("!!document.querySelector('.appointment-success-toast[role=alert]')",type+': pregnancy sync failure stays visible');
  check(await evaluate("!!window.test.record&&window.test.location.pathname.includes(window.test.appointmentId)&&!document.querySelector('.appointment-success-toast[role=status]')"),type+': partially saved record is not falsely announced as fully successful');
 }
 check(await evaluate('window.test.errors.length===0'),'No browser runtime errors or unhandled rejections');
 console.log(`PASS: ${checks} clinical save/Router/toast/scroll assertions. Actual forms and destination pages; synthetic backend only. Screenshots: ${temp}`);
}catch(error){const shot=await cdpForFailure?.('Page.captureScreenshot',{format:'png'}).catch(()=>null);if(shot){await writeFile(join(temp,'failure.png'),Buffer.from(shot.data,'base64'));console.error('Failure screenshot: '+join(temp,'failure.png'));}throw error;}finally{socket?.close();browser?.kill();await new Promise(r=>server.close(r));}
