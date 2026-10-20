// Offline browser fixture: actual Doctor form/CSS, synthetic reads, no Supabase client.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const root=fileURLToPath(new URL('../',import.meta.url));
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import Form from ${JSON.stringify(join(root,'src/pages/appointments/AppointmentVisitForm.jsx').replaceAll('\\','/'))};
window.test={reads:[],writes:[],errors:[],initial:false,mode:'ready'};
window.addEventListener('error',e=>window.test.errors.push(e.message));
window.remount=()=>create();let count=0;const root=createRoot(document.getElementById('root'));
function create(){root.render(<BrowserRouter><Form key={++count} appointmentId="synthetic-visit"
 requestedType={window.test.initial?'initial':'follow_up'} workspace="doctor"/></BrowserRouter>);}create();`;
const mock=`
const patient={id:'synthetic-patient',patient_id:'TEST-001',full_name:'Synthetic Patient',expected_delivery_date:'2027-01-10'};
const rows=[{id:'old-history',patient_id:patient.id,gravida:99,expected_delivery_date:'2026-01-01',updated_at:'2025-01-01'},
 {id:'selected-history',patient_id:patient.id,gravida:3,para:0,full_term:0,preterm:null,abortion_miscarriage:1,living_children:0,
 last_menstrual_period:'2026-04-01',expected_delivery_date:'2027-01-06',updated_at:'2026-10-01'}];
const response=data=>({data,error:null});
function query(table,initial){const filters={},orders=[];let columns='';
 const run=()=>{window.test.reads.push({table,filters,orders,columns});
  if(initial)return response(initial);
  if(table==='schedule')return response({id:'synthetic-visit',patient_id:patient.id,doctor_id:'synthetic-doctor',status:'checked_in',start_time:'2026-10-18T02:00:00Z'});
  if(table==='medical_records')return response(filters.schedule_id?null:[]);
  if(table==='patient_obstetric_history'){
   if(window.test.mode==='missing')return response(null);
   if(window.test.mode==='optional-error'&&columns.includes('gravida'))return {data:null,error:{code:'42703',message:'Synthetic optional column absent'}};
   let selected=rows.filter(row=>Object.entries(filters).every(([key,value])=>row[key]===value));
   for(const key of [...orders].reverse())selected.sort((a,b)=>String(b[key]??'').localeCompare(String(a[key]??'')));
   return response(selected[0]||null);
  }
  if(['patient_medical_history','patient_initial_assessment'].includes(table))return response(null);
  throw Error('Unexpected fixture query: '+table);
 };
 return {select(value){columns=value;return this;},eq(key,value){filters[key]=value;return this;},
  order(key){orders.push(key);return this;},limit(){return this;},maybeSingle:async()=>run(),then(resolve,reject){return Promise.resolve(run()).then(resolve,reject);}};
}
export const supabase={from:query,rpc(name){
 if(name==='get_appointment_visit_form_type')return Promise.resolve(response({visit_form_type:window.test.initial?'initial':'follow_up',appointment_status:'checked_in'}));
 if(name==='get_doctor_patient_directory')return query('directory',patient);
 if(name==='get_staff_visit_intake')return Promise.resolve(response({id:'synthetic-intake',intake_data:{expectedDeliveryDate:'2027-01-07'}}));
 window.test.writes.push(name);throw Error('Forbidden fixture write/RPC: '+name);
}};`;
const bundle=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
 name:'offline-followup-history',enforce:'pre',resolveId(id){
  if(id.endsWith('history-fixture.jsx'))return '\0history-fixture.jsx';
  if(id.endsWith('/supabaseClient'))return '\0synthetic-client';
 },load(id){if(id==='\0history-fixture.jsx')return fixture;if(id==='\0synthetic-client')return mock;}
}],build:{write:false,minify:false,lib:{entry:'history-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(bundle)?bundle:[bundle]).flatMap(item=>item.output);
const code=outputs.find(item=>item.type==='chunk').code.replaceAll('</script','<\\/script');
const css=outputs.filter(item=>item.fileName.endsWith('.css')).map(item=>item.source).join('\n');
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:12px;font-family:Arial}${css}</style><div id="root"></div><script type="module">${code}</script>`;
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const temporary=await mkdtemp(join(tmpdir(),'maternal-followup-history-'));
let browser,socket;
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
try{
 let executable;
 for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome']){
  try{await access(candidate);executable=candidate;break;}catch{/* Try the next installed browser. */}
 }
 assert.ok(executable,'Installed browser required');
 browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--remote-debugging-port=0',`--user-data-dir=${join(temporary,'profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let debugPort;
 for(let i=0;i<100&&!debugPort;i++){try{debugPort=(await readFile(join(temporary,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await pause();}}
 assert.ok(debugPort,'Isolated browser ready');
 const tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
 socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;
  pending.delete(message.id);clearTimeout(request.timer);if(message.error)request.reject(Error(JSON.stringify(message.error)));else request.resolve(message.result);};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},5000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true});
  assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
 const until=async(expression,label)=>{let passed;for(let i=0;i<100;i++){passed=await evaluate(expression);if(passed)break;await pause();}
  if(!passed)console.error(await evaluate("JSON.stringify({text:document.body.innerText.slice(0,300),active:document.activeElement?.outerHTML,errors:window.test?.errors})"));
  check(passed,label);};
 await cdp('Page.enable');await cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/doctor/appointments/synthetic-visit/follow-up`});
 await until("!!document.querySelector('.appointment-visit-history-toggle')",'Actual Follow-Up renders');
 await cdp('Page.bringToFront');
 const card="document.querySelector('.appointment-visit-stored-history')";
 const button="document.querySelector('.appointment-visit-history-toggle')";
 for(const width of [320,360,375,390,412,768,1024,1366,1920]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  check(await evaluate(`${button}.getAttribute('aria-expanded')==='false'&&!document.getElementById('follow-up-stored-obstetric-history').checkVisibility()`),`${width}px: initially collapsed`);
  check(await evaluate(`${card}.querySelectorAll('dl:not([hidden] dl) dt').length===4`),`${width}px: compact four-field summary`);
  await evaluate("Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.getElementById('chief-complaint'),'Synthetic unsaved complaint');document.getElementById('chief-complaint').dispatchEvent(new Event('input',{bubbles:true}))");
  await evaluate(`${button}.focus()`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  check(await evaluate(`document.activeElement===${button}&&getComputedStyle(${button}).outlineStyle!=='none'`),`${width}px: keyboard focus visible`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(`${button}.getAttribute('aria-expanded')==='true'`,`${width}px: Enter expands`);
  check(await evaluate(`(()=>{const d=document.getElementById('follow-up-stored-obstetric-history');return d.checkVisibility()&&d.querySelectorAll('dt').length===8&&${button}.textContent==='Hide Full History'})()`),`${width}px: all eight fields visible`);
  check(await evaluate(`(()=>{const c=${card},b=c.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&c.scrollWidth<=c.clientWidth&&[...c.querySelectorAll('dd')].every(e=>e.scrollWidth<=e.clientWidth)})()`),`${width}px: history fits without clipping`);
  check(await evaluate(`!${card}.querySelector('input,textarea,select')&&${button}.type==='button'`),`${width}px: read-only non-submitting control`);
  check(await evaluate(`(()=>{const values=[...document.getElementById('follow-up-stored-obstetric-history').querySelectorAll('dd')].map(e=>e.textContent);return JSON.stringify(values.slice(0,6))===JSON.stringify(['3','0','0','Not provided','1','0'])&&!values.includes('99')})()`),`${width}px: selected row, zero and null values`);
  check(await evaluate(`${card}.textContent.includes('January 6, 2027')&&document.getElementById('expected-delivery-date').value==='2027-01-07'`),`${width}px: stored and encounter EDD stay separate`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' ',unmodifiedText:' '});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await until(`${button}.getAttribute('aria-expanded')==='false'`,`${width}px: Space collapses`);
  check(await evaluate("document.getElementById('chief-complaint').value==='Synthetic unsaved complaint'"),`${width}px: collapse preserves clinical input`);
  check(await evaluate("window.test.writes.length===0"),`${width}px: disclosure never saves/completes the visit`);
 }
 for(const mode of ['missing','optional-error']){
  await evaluate(`window.test.mode='${mode}';window.remount()`);
  await until(`${card}?.textContent.includes('Stored obstetric history is unavailable')`,mode+': unavailable state');
  check(await evaluate(`!${button}&&!!document.getElementById('expected-delivery-date')`),mode+': no partial history, clinical form remains available');
 }
 await evaluate("window.test.mode='ready';window.test.initial=true;window.remount()");
 await until("!!document.querySelector('.appointment-visit-history-card')",'Existing Initial history renders');
 check(await evaluate(`!${card}&&document.body.textContent.includes('Reproductive & Obstetric History')`),'Initial has no duplicate Follow-Up summary');
 check(await evaluate("window.test.errors.length===0&&window.test.writes.length===0"),'No runtime errors or write attempts');
 console.log(`PASS: ${checks} Doctor Follow-Up browser assertions at nine widths; actual form/CSS, synthetic offline reads only.`);
}finally{
 socket?.close();browser?.kill();await new Promise(resolve=>server.close(resolve));
}
