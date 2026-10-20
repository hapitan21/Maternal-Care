// Offline actual Doctor Overview/Prenatal panels and medication-delete dialog. No live client.
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
const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {DoctorReminderContent as Doctor} from '__ROOT__/src/pages/doctor/Doctor_Reminder.jsx';
import {OverviewPanel,PrenatalHistoryPanel,mapSupabaseMedicalRecord,MedicalRecordTable} from '__ROOT__/src/pages/doctor/Doctor_Medical_Records.jsx';
import '__ROOT__/src/styles/doctor-dashboard.css';
window.test={writes:[],reads:[],errors:[],opens:[],deleteMode:'success',holdDelete:false};window.addEventListener('error',e=>window.test.errors.push(e.message));
window.test.long=('Synthetic clinical note with preserved content. '.repeat(60)+'\\nNext line <not-html> & preserved.');
const patient={id:'11111111-1111-4111-8111-111111111111',full_name:'Synthetic Patient',patient_id:'PAT-001'};
const related={obstetric:{gravida:2,para:0,full_term:0,preterm:0,living_children:0},medicalHistory:{id:'synthetic-history',medical_conditions:['Asthma'],family_history:Array.from({length:9},(_,i)=>({condition:'Synthetic family condition '+i,mother:true,father:false})),allergy_records:[{type:'Food',allergen:'Synthetic allergen',reaction:'Synthetic reaction'}]},initialAssessment:{smoking_status:'No',alcohol_intake:'No',drug_use:'No',physical_activity:'Walking',diet:'Synthetic diet'},personal:{occupation:'Synthetic occupation'}};
const records=[window.test.long,'Short visit note.','UnbrokenNote'.repeat(160)].map((note,i)=>mapSupabaseMedicalRecord({id:'record-'+i,schedule_id:'visit-'+i,patient_id:patient.id,created_at:'2026-10-'+(19-i)+'T02:00:00Z',form_data:{visitFormType:'follow_up',visitDate:'2026-10-'+(19-i),diagnosis:note,findings:[['Weight','60','kg'],['Blood Pressure','120/80','mmHg'],['Fetal Heart Rate','145','bpm']]}},patient));
function App(){const [page,setPage]=useState('overview'),[mode,setMode]=useState('long'),[longConditions,setLongConditions]=useState(false);window.test.setLongConditions=setLongConditions;window.test.setPage=setPage;window.test.setMode=setMode;
const text=mode==='long'?window.test.long:mode==='short'?'Short note.':mode==='unbroken'?'UnbrokenNote'.repeat(150):'';
const overview={lastVisit:mode==='missing'?null:{recordId:'record-0',date:'October 19, 2026',time:'10:00 AM',doctor:'Synthetic Doctor',visitType:'Follow-Up',assessment:text},latestNotes:mode==='missing'?null:{recordId:'record-0',sections:[['Chief Complaint',text],['Assessment',text],['Plan / Treatment',text]],updatedAt:'October 19, 2026'},pregnancyProgress:{weeks:28,progressPercent:70,stats:[]}};
return <div className='doctor-dashboard'><aside className='doctor-sidebar' aria-label='Synthetic sidebar'/><main className='doctor-main'><div className='doctor-content'>{page==='reminders'?<Doctor doctorIdentity={{authUser:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},loading:false}}/>:<section className='medical-records-page'><div className='medical-records-content'>
{page==='overview'?<OverviewPanel overview={overview} onOpenRecord={id=>window.test.opens.push(id)} onOpenAppointment={()=>{}}/>:page==='empty-visits'?<MedicalRecordTable columns={['Date','Gestational Age','Weight','Blood Pressure','Fetal Heart Rate','Notes']} rows={[["Oct 19, 2026","28 weeks","60 kg","120/80 mmHg","145 bpm",""]]} visitNotes/>:<PrenatalHistoryPanel patient={patient} patientRelated={{...related,medicalHistory:{...related.medicalHistory,other_medical_condition:longConditions?window.test.long:""}}} records={records}/>}
</div></section>}</div></main></div>;}createRoot(document.getElementById('root')).render(<App/>);`.replaceAll("__ROOT__",root.replaceAll("\\","/"));
const mock=`
const people=[{id:'11111111-1111-4111-8111-111111111111',patient_id:'PAT-001',full_name:'Synthetic Patient',contact_number:'09000000001'},
 {id:'22222222-2222-4222-8222-222222222222',patient_id:'PAT-002',full_name:'Synthetic Patient',contact_number:'09000000002'}];
function query(table){let operation='read',payload,search='',matchId;let single=false;
 const q={select(){return q;},eq(key,value){if(key==='id')matchId=value;return q;},order(){return q;},limit(){return q;},in(){return q;},gte(){return q;},lt(){return q;},
 ilike(key,value){search=value;return q;},or(value){search=value;return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
 insert(value){operation='insert';payload=value;return q;},update(value){operation='update';payload=value;return q;},delete(){operation='delete';return q;},
 then(resolve,reject){window.test.reads.push({table,search});let data=[];
 if(operation==='delete'&&table==='medication_reminders'){
 window.test.writes.push({table,operation,matchId});
 const respond=()=>{if(window.test.deleteMode==='network')return Promise.reject(Error('Synthetic uncertain response'));
 if(window.test.deleteMode==='history')return Promise.resolve({data:null,error:{code:'23503',message:'Synthetic linked history'}});
 if(window.test.deleteMode==='reject')return Promise.resolve({data:null,error:{code:'42501',message:'Synthetic forbidden'}});
 window.test.deleted=true;return Promise.resolve({data:null,error:null});};
 return (window.test.holdDelete?new Promise(done=>window.test.releaseDelete=()=>done(respond())):respond()).then(resolve,reject);
 }
 if(operation!=='read'){window.test.writes.push({table,operation,payload});return Promise.resolve({data:single?{id:'synthetic-saved'}:[],error:null}).then(resolve,reject);}
 if(table==='patients')data=people;
 if(table==='medication_reminders'&&!window.test.deleted)data=[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',patient_id:people[0].id,medication_name:'Synthetic Medication',dosage:'1 tablet',frequency:'Once daily',reminder_times:['08:00:00'],start_date:'2026-01-01',end_date:'2030-12-31',status:'active'}];
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
 transform(code,id){if(id.replaceAll('\\','/').endsWith('/pages/doctor/Doctor_Medical_Records.jsx'))return code+'\nexport {PrenatalHistoryPanel,mapSupabaseMedicalRecord,MedicalRecordTable};';if(id.replaceAll('\\','/').endsWith('/pages/doctor/Doctor_Reminder.jsx'))return code+'\nexport {DoctorReminderContent};';}
}],build:{write:false,minify:false,lib:{entry:'reminder-interactions-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(bundle)?bundle:[bundle]).flatMap(x=>x.output);
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial;padding:12px}${outputs.filter(x=>x.fileName.endsWith('.css')).map(x=>x.source).join('\n').replace(/@import\s+url\([^)]*\)\s*;/g,'')}</style><div id="root"></div><script type="module">${outputs.find(x=>x.type==='chunk').code.replaceAll('</script','<\\/script')}</script>`;
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const temp=await mkdtemp(join(tmpdir(),'maternal-doctor-clinical-previews-'));let browser,socket,cdpForFailure;
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
 const click=async(selector,touch=false)=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if(touch){await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else{await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});}};
 const key=async name=>{const number={Enter:13,Escape:27,Tab:9}[name];await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:number,...(name==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,windowsVirtualKeyCode:number});};
 const screenshot=async name=>{await pause(450);const r=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(temp,name+'.png'),Buffer.from(r.data,'base64'));};
 await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*']});
 await cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
 await until("!!document.querySelector('.mr-overview-dashboard-grid')",'Actual Overview mounted');
 await cdp('Page.bringToFront');
 for(const width of [320,360,390,430,768,1024,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  for(const mode of ['short','long','unbroken','empty','missing']){
   await evaluate(`window.test.setMode('${mode}')`);await pause(100);
   const count=await evaluate("document.querySelectorAll('.mr-clinical-preview__toggle').length");
   check(count===(['long','unbroken'].includes(mode)?4:0),`${width}: ${mode} controls only for overflowing fields`);
   check(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),`${width}: ${mode} no page overflow`);
   if(count){
    const text=await evaluate("document.querySelector('.mr-clinical-preview__text').textContent");
    check(await evaluate("[...document.querySelectorAll('.mr-clinical-preview__text')].every(e=>e.clientHeight<=parseFloat(getComputedStyle(e).lineHeight)*4+1&&e.scrollHeight>e.clientHeight)"),`${width}: four-line previews`);
    await evaluate("document.querySelector('.mr-clinical-preview__toggle').focus()");await key('Enter');await pause();
    check(await evaluate("document.querySelector('.mr-clinical-preview__toggle').getAttribute('aria-expanded')==='true'&&!!document.getElementById(document.querySelector('.mr-clinical-preview__toggle').getAttribute('aria-controls'))"),`${width}: keyboard expansion and linked text`);
    check(await evaluate(`(()=>{const e=document.querySelector('.mr-clinical-preview__text');return e.textContent===${JSON.stringify(text)}&&e.clientHeight>=e.scrollHeight-1&&!e.querySelector('not-html')})()`),`${width}: exact full text, safe escaping`);
    check(await evaluate("getComputedStyle(document.querySelector('.mr-overview-dashboard-grid')).alignItems==='start'"),`${width}: unrelated Overview column does not stretch`);
    await key('Enter');await pause();
    check(await evaluate("document.querySelector('.mr-clinical-preview__toggle').getAttribute('aria-expanded')==='false'"),`${width}: collapse retains focus`);
   }
  }
  await evaluate("window.test.setMode('long')");await pause();
  await evaluate("document.querySelector('.mr-last-visit-card > button').click();document.querySelector('.mr-notes-open-btn').click()");
  check(await evaluate("window.test.opens.slice(-2).every(id=>id==='record-0')"),`${width}: both existing full-record actions retained`);
  if([390,1366].includes(width)){await evaluate('window.scrollTo(0,0)');await screenshot('overview-'+width);}
 }
 await evaluate("window.test.setPage('prenatal')");await until("!!document.querySelector('.mr-prenatal-layout')",'Actual Prenatal History mounted');
 for(const width of [320,360,390,430,768,1024,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(150);
  check(await evaluate("[...document.querySelectorAll('.mr-prenatal-title')].map(e=>e.textContent[0]).join('')==='12345678'"),`${width}: eight sections in original DOM order`);
  check(await evaluate("['Asthma','Synthetic family condition 8','Synthetic allergen','Synthetic reaction','Synthetic occupation','Synthetic diet'].every(s=>document.body.textContent.includes(s))"),`${width}: clinical history content preserved`);
  check(await evaluate("document.querySelectorAll('.mr-prenatal-table--visit-notes tbody tr').length===3"),`${width}: all distinct visits retained`);
  check(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),`${width}: tables scroll locally`);
  check(await evaluate("[...document.querySelectorAll('.mr-prenatal-table--visit-notes td:not(:last-child)')].every(e=>getComputedStyle(e).whiteSpace==='nowrap'&&e.scrollWidth<=e.clientWidth+1)"),`${width}: date and numeric values stay legible`);
  check(await evaluate("[...document.querySelectorAll('.mr-prenatal-table--visit-notes .mr-clinical-preview__text')].every(e=>e.clientHeight<=parseFloat(getComputedStyle(e).lineHeight)*3+1)"),`${width}: visit notes clamped to three lines`);
  const note='.mr-prenatal-table--visit-notes .mr-clinical-preview__toggle';
  await evaluate(`document.querySelector('${note}').focus()`);await key('Enter');await pause();
  check(await evaluate("(()=>{const e=document.querySelector('.mr-prenatal-table--visit-notes .mr-clinical-preview__text');return e.textContent===window.test.long&&e.clientHeight>=e.scrollHeight-1&&e.textContent.includes('\\nNext line')})()"),`${width}: full original multiline note available`);
  await key('Enter');await pause();
  const positions=await evaluate("[...document.querySelector('.mr-prenatal-compact-grid').children].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,height:r.height}})");
  if(width>900){
   check(Math.abs(positions[2].top-positions[0].bottom-18)<2&&Math.abs(positions[3].top-positions[1].bottom-18)<2,`${width}: independent column spacing without tall-row whitespace`);
   check(positions[0].height!==positions[1].height,`${width}: short card not stretched`);
   await evaluate('window.test.setLongConditions(true)');await pause(150);
   check(await evaluate("(()=>{const r=[...document.querySelector('.mr-prenatal-compact-grid').children].map(e=>e.getBoundingClientRect());return r[0].height>r[1].height&&Math.abs(r[2].top-r[0].bottom-18)<2&&Math.abs(r[3].top-r[1].bottom-18)<2})()"),`${width}: either column can grow without adding whitespace to the other`);
   await evaluate('window.test.setLongConditions(false)');await pause(150);
  }else check(positions.every((p,i)=>!i||p.top>=positions[i-1].bottom+17),`${width}: numbered mobile stacking`);
  if([390,1366].includes(width)){await evaluate("document.querySelector('.mr-prenatal-compact-grid').scrollIntoView({block:'start'})");await screenshot('prenatal-history-'+width);await evaluate("document.querySelector('.mr-prenatal-table--visit-notes').scrollIntoView({block:'start'})");await screenshot('visit-notes-'+width);}
 }
 await evaluate("window.test.setPage('empty-visits')");await pause();
 for(const width of [320,360,390,430,768,1024,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause();
  check(await evaluate("document.querySelector('.mr-clinical-preview__text').textContent===''&&!document.querySelector('.mr-clinical-preview__toggle')"),`${width}: empty visit note has no invented text or expansion`);
  check(await evaluate("document.querySelector('.mr-prenatal-table-wrap').tabIndex===0&&document.documentElement.scrollWidth<=innerWidth+1"),`${width}: keyboard-accessible table scroll, no page overflow`);
 }
 await evaluate("window.test.setPage('reminders')");await until("!!document.querySelector('.doctor-medication-actions button[title=\"Delete reminder\"]')",'Actual medication reminder mounted');
 const trigger='.doctor-medication-actions button[title="Delete reminder"]';
 const dialog='.doctor-medication-delete-dialog';
 for(const width of [320,360,390,430,768,1024,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await pause(150);await click(trigger);await until(`!!document.querySelector('${dialog}')`,`${width}: Delete opens confirmation`);
  check(await evaluate(`document.querySelector('${dialog}').textContent.includes('Synthetic Medication')&&document.querySelector('${dialog}').textContent.includes('Synthetic Patient')&&window.test.writes.length===0`),`${width}: context and no immediate delete`);
  check(await evaluate(`document.activeElement===document.querySelector('${dialog} button')&&document.activeElement.textContent==='Cancel'`),`${width}: safe initial focus`);
  await key('Tab');await key('Tab');check(await evaluate(`document.querySelector('${dialog}').contains(document.activeElement)`),`${width}: focus containment`);
  check(await evaluate(`(()=>{const r=document.querySelector('${dialog}').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`),`${width}: responsive bounds`);
  if(width===390)await screenshot('delete-confirmation-390');
  await key('Escape');await until(`!document.querySelector('${dialog}')`,`${width}: Escape cancels`);
  check(await evaluate('window.test.writes.length===0'),`${width}: cancellation never writes`);
  check(await evaluate(`document.activeElement===document.querySelector('${trigger}')`),`${width}: focus returns to Delete trigger`);
 }
 await evaluate("document.querySelector('.doctor-medication-card .doctor-reminder-card__header button').click()");
 await until("!!document.querySelector('.doctor-reminder-view-all')",'Medication View All opens');
 await click('.doctor-reminder-view-all '+trigger);
 await until(`!!document.querySelector('${dialog}')&&!document.querySelector('.doctor-reminder-view-all')`,'View All Delete switches to visible confirmation');
 await key('Escape');await until(`!document.querySelector('${dialog}')`,'View All confirmation cancels');
 check(await evaluate('window.test.writes.length===0'),'View All cancellation never writes');
 await click(trigger);await evaluate(`document.querySelector('${dialog} button').click()`);await until(`!document.querySelector('${dialog}')`,'Cancel button closes');
 check(await evaluate('window.test.writes.length===0'),'Cancel button makes no database change');
 await click(trigger);await evaluate("document.querySelector('.doctor-medication-delete-dialog').parentElement.click()");await until(`!document.querySelector('${dialog}')`,'Backdrop cancels without changes');
 for(const mode of ['history','reject','network']){
  await evaluate(`window.test.deleteMode='${mode}';window.test.holdDelete=true`);const before=await evaluate('window.test.writes.length');
  await click(trigger);await evaluate(`(()=>{const b=document.querySelector('${dialog} button:last-child');b.click();b.click();})()`);await pause();
  check(await evaluate(`window.test.writes.length===${before+1}&&[...document.querySelectorAll('${dialog} button')].every(e=>e.disabled)`),mode+': rapid clicks send once and disable controls');
  await key('Escape');check(await evaluate(`!!document.querySelector('${dialog}')`),mode+': busy Escape cannot dismiss');
  await evaluate('window.test.releaseDelete()');await until(`!!document.querySelector('${dialog} [role=alert]')`,mode+': failure shown');
  check(await evaluate(`!!document.querySelector('${trigger}')&&!window.test.deleted`),mode+': original reminder preserved');
  check(await evaluate("window.test.writes.every(w=>w.table==='medication_reminders'&&w.operation==='delete'&&w.matchId==='cccccccc-cccc-4ccc-8ccc-cccccccccccc')"),mode+': only original delete operation, no history writes');
  if(mode==='history')check(await evaluate(`document.querySelector('${dialog} [role=alert]').textContent.includes('history have been preserved')`),'Foreign-key restriction explained');
  if(mode==='network')check(await evaluate(`document.querySelector('${dialog} button:last-child').disabled`),'Uncertain result not blindly resubmitted');
  await evaluate(`document.querySelector('${dialog} button').click()`);await until(`!document.querySelector('${dialog}')`,mode+': can close after failure');
 }
 await evaluate("window.test.deleteMode='success';window.test.holdDelete=true");const before=await evaluate('window.test.writes.length');
 await click(trigger);await evaluate(`(()=>{const b=document.querySelector('${dialog} button:last-child');b.click();b.click();})()`);await pause();
 check(await evaluate(`window.test.writes.length===${before+1}`),'Success duplicate clicks issue exactly one request');
 await evaluate('window.test.releaseDelete()');await until(`!document.querySelector('${dialog}')&&!document.querySelector('${trigger}')`,'Successful acknowledged delete refreshes the list');
 check(await evaluate("document.body.textContent.includes('Delete request completed')"),'Acknowledged request feedback does not invent an affected-row receipt');
 await evaluate('window.test.deleted=false;window.test.setPage("overview")');await pause();await evaluate('window.test.setPage("reminders")');
 await until(`!!document.querySelector('${trigger}')`,'Synthetic reminder restored by fixture remount only');
 const previousWrites=await evaluate('window.test.writes.length');
 await click('.doctor-medication-actions button[title="Mark complete"]');await until(`window.test.writes.length===${previousWrites+1}`,'Existing Mark Complete submits');
 check(await evaluate("(()=>{const w=window.test.writes.at(-1);return w.table==='medication_reminders'&&w.operation==='update'&&w.payload.status==='completed'})()"),'Existing Mark Complete persistence unchanged');
 check(await evaluate('window.test.errors.length===0'),'No browser runtime errors');
 console.log(`PASS: ${checks} Doctor clinical-preview/delete assertions; actual components and CSS, synthetic backend only. Screenshots: ${temp}`);
}catch(error){const shot=await cdpForFailure?.('Page.captureScreenshot',{format:'png'}).catch(()=>null);if(shot){await writeFile(join(temp,'failure.png'),Buffer.from(shot.data,'base64'));console.error('Failure screenshot: '+join(temp,'failure.png'));}throw error;}finally{socket?.close();browser?.kill();await new Promise(r=>server.close(r));}
