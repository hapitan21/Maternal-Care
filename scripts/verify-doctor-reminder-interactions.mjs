// Actual Doctor Reminders, dialog manager and CSS. Synthetic backend only.
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
import {DoctorReminderContent as Doctor} from ${JSON.stringify(join(root,'src/pages/doctor/Doctor_Reminder.jsx').replaceAll('\\','/'))};
window.test={writes:[],reads:[],pending:[],hold:false,errors:[]};window.addEventListener('error',e=>window.test.errors.push(e.message));
createRoot(document.getElementById('root')).render(<Doctor doctorIdentity={{authUser:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},loading:false}}/>);`;
const mock=`
const people=[{id:'11111111-1111-4111-8111-111111111111',patient_id:'PAT-001',full_name:'Synthetic Patient',contact_number:'09000000001'},
 {id:'22222222-2222-4222-8222-222222222222',patient_id:'PAT-002',full_name:'Synthetic Patient',contact_number:'09000000002'}];
function query(table){let operation='read',payload,search='';let single=false;
 const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},in(){return q;},gte(){return q;},lt(){return q;},
 ilike(key,value){search=value;return q;},or(value){search=value;return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
 insert(value){operation='insert';payload=value;return q;},update(value){operation='update';payload=value;return q;},delete(){operation='delete';return q;},
 then(resolve,reject){window.test.reads.push({table,search});let data=[];
 if(operation!=='read'){window.test.writes.push({table,operation,payload});return Promise.resolve({data:single?{id:'synthetic-saved'}:[],error:null}).then(resolve,reject);}
 if(table==='directory')data=people.filter(p=>!search||search.toLowerCase().includes('synthetic')||search.includes(p.patient_id));
 if(table==='schedule')data=[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',patient_id:people[0].id,patient_name:people[0].full_name,doctor_name:'Synthetic Doctor',title:'Prenatal Checkup',start_time:'2030-10-19T02:00:00Z',end_time:'2030-10-19T02:30:00Z',status:'scheduled'}];
 if(table==='health_tips')data=[{id:'synthetic-tip',title:'Synthetic tip',content:'Synthetic content',category:'Nutrition',is_active:true,created_by:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}];
 const result={data:single?data[0]||null:data,error:null};
 if(table==='directory'&&search&&window.test.hold)return new Promise(done=>window.test.pending.push(()=>done(result))).then(resolve,reject);
 return Promise.resolve(result).then(resolve,reject);
 }};return q;}
export const supabase={from:query,rpc(name){if(name==='get_doctor_patient_directory')return query('directory');throw Error('Unexpected RPC: '+name);},
 channel(){const q={on(){return q;},subscribe(){return q;}};return q;},removeChannel(){},auth:{getUser:async()=>({data:{user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},error:null})}};`;
const bundle=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
 name:'isolated-doctor-reminders',enforce:'pre',resolveId(id){if(id.endsWith('reminder-interactions-fixture.jsx'))return '\0reminder-interactions-fixture.jsx';
  if(id.endsWith('/supabaseClient'))return '\0synthetic-client';if(id.endsWith('/useAuthenticatedDoctor'))return '\0synthetic-doctor';
  if(id==='@iconify/react')return '\0fixture-icon';},
 load(id){if(id==='\0reminder-interactions-fixture.jsx')return fixture;if(id==='\0synthetic-client')return mock;
  if(id==='\0synthetic-doctor')return 'export async function loadAuthenticatedDoctor(){return {authUser:{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}}';
   if(id==='\0fixture-icon')return 'import React from "react";export function Icon(p){return React.createElement("svg",{"aria-hidden":true,width:22,height:22,viewBox:"0 0 24 24"},p.icon?.includes("close")?React.createElement("path",{d:"M6 6L18 18M18 6L6 18",stroke:"currentColor",strokeWidth:2}):null)}';},
 transform(code,id){if(id.replaceAll('\\','/').endsWith('/pages/doctor/Doctor_Reminder.jsx'))return code+'\nexport {DoctorReminderContent};';}
}],build:{write:false,minify:false,lib:{entry:'reminder-interactions-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(bundle)?bundle:[bundle]).flatMap(x=>x.output);
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial;padding:12px}${outputs.filter(x=>x.fileName.endsWith('.css')).map(x=>x.source).join('\n').replace(/@import\s+url\([^)]*\)\s*;/g,'')}</style><div id="root"></div><script type="module">${outputs.find(x=>x.type==='chunk').code.replaceAll('</script','<\\/script')}</script>`;
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const temp=await mkdtemp(join(tmpdir(),'maternal-doctor-reminders-'));let browser,socket;
const pause=(ms=50)=>new Promise(r=>setTimeout(r,ms));
try{
 let executable;for(const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome']){try{await access(p);executable=p;break;}catch{/* Try the next platform's browser path; availability is asserted below. */}}
 assert.ok(executable,'Installed browser');browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${join(temp,'profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<120&&!port;i++){try{port=(await readFile(join(temp,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await pause();}}
 assert.ok(port,'Browser ready');const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let id=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),5000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async(expression,label)=>{let result;for(let i=0;i<100;i++){result=await evaluate(expression);if(result)break;await pause();}if(!result)console.error(await evaluate("JSON.stringify({errors:window.test?.errors,close:(()=>{const e=document.querySelector('.doctor-reminder-dialog-close');return e?{rect:e.getBoundingClientRect().toJSON(),width:getComputedStyle(e).width,height:getComputedStyle(e).height,position:getComputedStyle(e).position}:null})(),text:document.body.textContent.slice(-300)})"));check(result,label);};
 const change=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 const click=async(selector,touch=false)=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if(touch){await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else{await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});}};
 await cdp('Page.enable');await cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await until("!!document.querySelector('.doctor-medication-card')",'Actual Doctor Reminders mounted');await cdp('Page.bringToFront');
 const openMedication=async()=>{await evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add Medication');b.focus({preventScroll:true});b.click()})()");await until("!!document.querySelector('.doctor-medication-reminder-form')",'Medication opens');};
 const input='.doctor-patient-search input';
 await openMedication();await change(input,'Synthetic');await until("document.querySelectorAll('.doctor-patient-results button').length===2",'Authorized search results');
 await click('.doctor-patient-results button');await pause(450);
  check(await evaluate("document.querySelector('.doctor-patient-search input').value==='Synthetic Patient'&&!document.querySelector('.doctor-patient-results')"),'One physical click selects and keeps the name without reopening results');
  check(await evaluate("window.test.reads.filter(r=>r.table==='directory'&&r.search).length===1"),'Confirmed selection does not issue another search');
  const key=async(name,code,number,text)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:number,...(text?{text,unmodifiedText:text}:{})});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:number});};
  const close='.doctor-reminder-dialog-close';
  await click(close);await until("!document.querySelector('[role=dialog]')",'Medication X closes without saving');
  const dialogs=[
   {name:'appointment list',open:"document.querySelector('.doctor-reminder-card__header button').click()",dialog:'.doctor-reminder-view-all'},
   {name:'appointment form',open:"[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Set Reminder').click()",dialog:'.doctor-reminder-form--appointment'},
   {name:'medication list',open:"document.querySelector('.doctor-medication-card .doctor-reminder-card__header button').click()",dialog:'.doctor-reminder-view-all'},
   {name:'medication form',open:"[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add Medication').click()",dialog:'.doctor-medication-reminder-form'},
   {name:'health tip list',open:"document.querySelector('.doctor-health-tips-card .doctor-reminder-card__header button').click()",dialog:'.doctor-reminder-view-all'},
   {name:'health tip form',open:"[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add Health Tip').click()",dialog:'.doctor-health-tip-form'},
  ];
  for(const width of [320,360,375,390,412,768,1366]){
   await cdp('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
   for(const test of dialogs){
    await evaluate(`(()=>{const b=${test.open.slice(0,-8)};b.focus({preventScroll:true});b.click()})()`);await until(`!!document.querySelector('${test.dialog}')`,width+' '+test.name+' opens');
    await until(`Math.abs(document.querySelector('${close}').getBoundingClientRect().width-44)<0.1`, 'Modal opening animation settles before measuring');
    if(process.argv.includes('--diagnose'))console.log(test.name,await evaluate(`(()=>{const e=document.querySelector('${close}'),s=getComputedStyle(e),r=e.getBoundingClientRect(),d=e.closest('[role=dialog]');return {width:r.width,height:r.height,color:s.color,background:s.backgroundColor,box:[r.left,r.top,r.right,r.bottom],dialog:[d.getBoundingClientRect().left,d.getBoundingClientRect().right],columns:getComputedStyle(d).gridTemplateColumns,headerWidth:e.parentElement.getBoundingClientRect().width,headline:[getComputedStyle(e.previousElementSibling).flex,getComputedStyle(e.previousElementSibling).width]}})()`));
    check(await evaluate(`(()=>{const e=document.querySelector('${close}'),s=getComputedStyle(e),r=e.getBoundingClientRect(),d=e.closest('[role=dialog]').getBoundingClientRect();return Math.abs(r.width-44)<0.1&&Math.abs(r.height-44)<0.1&&s.color==='rgb(215, 46, 105)'&&s.backgroundColor==='rgb(255, 240, 246)'&&r.left>=d.left&&r.right<=d.right&&r.top>=0&&r.bottom<=innerHeight&&e.type==='button'&&!!e.getAttribute('aria-label')})()`),width+' '+test.name+': consistent pink 44px target');
    await evaluate(`(()=>{const d=document.querySelector('${test.dialog}');for(const e of d.querySelectorAll('*'))if(e.scrollHeight>e.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(e).overflowY))e.scrollTop=10000})()`);
    check(await evaluate(`(()=>{const e=document.querySelector('${close}'),r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===e})()`),width+' '+test.name+': close remains reachable while content scrolls');
    if(width===375&&test.name==='medication form')await writeFile(join(temp,'medication-close-375.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    if(width===360){await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await click(close,true);await cdp('Emulation.setTouchEmulationEnabled',{enabled:false});}
    else if(width===768||width===1366){await evaluate(`document.querySelector('${close}').focus()`);await key(width===768?'Enter':' ',width===768?'Enter':'Space',width===768?13:32,width===768?'\r':' ');}
    else await click(close);
    await until("!document.querySelector('[role=dialog]')",width+' '+test.name+': X closes once');
    check(await evaluate("window.test.writes.length===0"),'Cancel never saves/deletes/archives');
    check(await evaluate("document.activeElement?.isConnected&&!document.activeElement.closest('[role=dialog]')&&document.activeElement.tagName==='BUTTON'"),'Focus restored to a page control');
   }
   await openMedication();await change(input,'Synthetic');await until("document.querySelectorAll('.doctor-patient-results button').length===2",'Fresh authorized search');
   check(await evaluate("document.querySelector('.doctor-patient-results').textContent.includes('PAT-001')&&document.querySelector('.doctor-patient-results').textContent.includes('PAT-002')"),'Duplicate names distinguish Patient IDs');
   if(width===375){await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await click('.doctor-patient-results button:nth-child(2)',true);await cdp('Emulation.setTouchEmulationEnabled',{enabled:false});}
   else if(width===768){await evaluate("document.querySelector('.doctor-patient-search input').focus()");await key('ArrowDown','ArrowDown',40);await key('ArrowDown','ArrowDown',40);await key('Enter','Enter',13,'\r');}
   else await click('.doctor-patient-results button:nth-child(2)');
   await until("document.querySelector('.doctor-patient-search input').value==='Synthetic Patient'&&!document.querySelector('.doctor-patient-results')",'Single mouse/touch/keyboard selection persists');
   await change('[name=prescriptionReference]','Synthetic RX');await pause(350);
   check(await evaluate("document.querySelector('.doctor-patient-search input').value==='Synthetic Patient'&&!document.querySelector('.doctor-patient-results')"),'Continuing prescription entry preserves confirmed Patient');
   await change(input,'');await pause(350);check(await evaluate("!document.querySelector('.doctor-patient-results')&&document.querySelector('.doctor-patient-search input').value===''"),'Clear removes selection and suggestions');
   await change(input,'PAT-001');await until("document.querySelectorAll('.doctor-patient-results button').length===1",'Patient ID search returns only correct recipient');
   await click('.doctor-patient-results button');await until("!document.querySelector('.doctor-patient-results')",'Clear/reselect works immediately');
   await click(close);await until("!document.querySelector('[role=dialog]')",'Selection-only flow cancels without writes');
   await evaluate("document.querySelector('.doctor-health-tips-card .doctor-reminder-card__header button').click()");
   await until("!!document.querySelector('.doctor-health-tip-menu-button')",'Health Tip edit entry available');
   await click('.doctor-health-tip-menu-button');await until("!!document.querySelector('.doctor-health-tip-action-menu')",'Existing edit menu opens');
   await evaluate("[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim()==='Edit').click()");
   await until("document.querySelector('#doctor-health-tip-form-title')?.textContent==='Edit Health Tip'",'Existing Health Tip edit form opens');
   await click(close);await until("!document.querySelector('[role=dialog]')",'Edit Health Tip X cancels without mutations');
   await openMedication();await key('Escape','Escape',27);await until("!document.querySelector('[role=dialog]')",'Existing Escape cancellation retained');
   await openMedication();await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:1,y:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:1,y:1});
   await until("!document.querySelector('[role=dialog]')",'Existing backdrop cancellation retained');
   check(await evaluate('window.test.writes.length===0'),'All edit/X/Escape/backdrop cancellations are read-only');
  }
  await openMedication();await evaluate('window.test.hold=true');await change(input,'PAT-002');await until('window.test.pending.length===1','Older search is in flight');
  await evaluate('window.test.hold=false');await change(input,'PAT-001');await until("document.querySelectorAll('.doctor-patient-results button').length===1",'Newer search resolves first');
  await click('.doctor-patient-results button');await evaluate('window.test.pending.shift()()');await pause(350);
  check(await evaluate("document.querySelector('.doctor-patient-search input').value==='Synthetic Patient'&&!document.querySelector('.doctor-patient-results')"),'Late response cannot overwrite confirmed selection or reopen suggestions');
  await change(input,'not a patient');await pause(350);await evaluate("document.querySelector('.doctor-medication-reminder-form').requestSubmit()");
  check(await evaluate('window.test.writes.length===0'),'Invalid edits cannot submit stale Patient identity');
  check(await evaluate("document.querySelector('.doctor-medication-reminder-form .doctor-reminder-message')?.textContent.includes('Select a registered patient')"),'Invalid edit clears the selected UUID before any prescription validation');
  await change(input,'PAT-002');await until("document.querySelectorAll('.doctor-patient-results button').length===1",'Switch to second matching-name Patient');await click('.doctor-patient-results button');
  for(const [name,value]of [['prescriptionReference','Synthetic RX'],['medication','Biogesic'],['dosage','1 tablet'],['frequency','Once daily'],['duration','3 days'],['scheduleDate','2030-10-18']])await change('[name='+name+']',value);
  await evaluate("document.getElementById('doctor-medication-reminder-time').click()");await until("!!document.querySelector('.appointment-time-picker__popover')",'Existing medication time picker opens');
  await change('[aria-label=Hour]','07');await change('[aria-label=Minute]','26');await change('[aria-label="AM or PM"]','PM');await evaluate("document.querySelector('.appointment-time-picker__apply').click()");
  await evaluate("document.querySelector('.doctor-medication-reminder-confirm-time').click()");await until("!!document.querySelector('.doctor-medication-reminder-time-chip')",'Existing Add time contract retained');
  check(await evaluate('window.test.writes.length===0'),'No mutation before Save Reminder');
  await evaluate("document.querySelector('.doctor-medication-reminder-form').requestSubmit()");await until('window.test.writes.length===1','Existing explicit Save Reminder inserts once');
  const saved=await evaluate('window.test.writes[0]');check(saved.table==='medication_reminders'&&saved.operation==='insert','Same medication persistence path');
  assert.deepEqual(Object.fromEntries(['patient_id','medication_name','dosage','frequency','duration','reminder_times','start_date','end_date','status'].map(k=>[k,saved.payload[0][k]])),{patient_id:'22222222-2222-4222-8222-222222222222',medication_name:'Biogesic',dosage:'1 tablet',frequency:'Once daily',duration:'3 days',reminder_times:['19:26:00'],start_date:'2030-10-18',end_date:'2030-10-20',status:'active'});checks++;
  check(await evaluate('window.test.errors.length===0'),'No browser errors');
 console.log(`PASS: ${checks} Doctor reminder interaction assertions; no live backend.`);
 console.log('Screenshot: '+join(temp,'medication-close-375.png'));
}finally{socket?.close();browser?.kill();await new Promise(r=>server.close(r));}
