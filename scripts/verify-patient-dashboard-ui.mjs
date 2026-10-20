// Actual Dashboard/modal/list and navigation markup; synthetic read-only Supabase/tracking.
// Isolated localhost fixture only. No authenticated application, FCM, SMS or database calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFile(join(root,p),'utf8');
const dashboard=await read('src/pages/patient/Patient_PWA_Dashboard.jsx');
const reminder=await read('src/pages/patient/Patient_PWA_Reminder.jsx');
const shell=await read('src/pages/patient/Patient_PWA.jsx');
const navStart=shell.indexOf('<nav className="pwa-nav"');
const nav=shell.slice(navStart,shell.indexOf('</nav>',navStart)+6);
const items=shell.match(/const navItems = \[[\s\S]*?\n\];/)[0];
const navigationIcon=shell.slice(shell.indexOf('function PatientNavigationIcon('),shell.indexOf('const pageRoutes ='));
const routes=shell.match(/const pageRoutes = \{[\s\S]*?\n};/)[0];
const navigateHandler=shell.match(/ {2}const handleNavigate = [\s\S]*?\n {2}};/)[0];
let assertions=0;
const check=(v,label)=>{assert.ok(v,label);assertions++;};
check(!dashboard.includes('PatientQuickLink')&&!dashboard.includes('Quick access'),'Dashboard Quick Access removed');
check(dashboard.includes('.from("health_tips")')&&reminder.includes('.from("health_tips")'),'Same existing Supabase source');
check(dashboard.includes('getPatientHealthTips(data, profile.recordId)')&&!dashboard.includes('getStoredHealthTips')&&!reminder.includes('getStoredHealthTips'),'Patient tips use authorized database data without local/default merging');
check(reminder.includes('<PatientHealthTipsPreview')&&reminder.includes('MedicationScheduleAdherenceScreen'),'Reminders uses the shared preview and retains its separate medication screen');
const fixture=`
import React,{useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRouter,useNavigate,useLocation} from 'react-router-dom';
import {AlarmClock} from 'lucide-react';
import Dashboard from ${JSON.stringify(join(root,'src/pages/patient/Patient_PWA_Dashboard.jsx').replaceAll('\\','/'))};
import {PatientHealthTipList} from ${JSON.stringify(join(root,'src/components/patient/PatientHealthTipsPreview.jsx').replaceAll('\\','/'))};
import {clearPatientPwaSessionCache,getPatientPwaSessionCache} from ${JSON.stringify(join(root,'src/lib/patientPwaSessionCache.js').replaceAll('\\','/'))};
window.clearTipSession=clearPatientPwaSessionCache;
window.cachedTips=()=>getPatientPwaSessionCache('synthetic-patient','health-tips');
const Icon=()=> <svg width="22" height="22" aria-hidden="true"/>;
${navigationIcon}
${items}
${routes}
window.test={errors:[],queries:[],notifications:[],hold:false,error:false,listeners:new Set(),rows:[]};
window.Notification=class{static permission='granted';constructor(){window.test.notifications.push('unexpected notification');}};
const NativeDate=Date;window.test.now=NativeDate.parse('2026-10-18T04:00:00Z');
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[window.test.now]));}static now(){return window.test.now;}};
const nativeSetTimeout=window.setTimeout.bind(window);window.setTimeout=(fn,delay,...args)=>{
 if(delay>3600000)window.dailyTick=fn;return nativeSetTimeout(fn,delay,...args);};
localStorage.setItem('doctor_health_tips',JSON.stringify(Array.from({length:5},(_,i)=>({id:'legacy-'+i,title:'Legacy forbidden '+i,text:'Unverified local text'}))));
window.addEventListener('error',e=>window.test.errors.push(e.message));
window.setWeek=week=>{window.test.pregnancy={status:'ready',tracking:{hasCurrentPregnancy:true,week,
  trimester:{label:'Synthetic trimester'},weeksRemaining:40-week,progressPercent:50,expectedDeliveryDate:'2030-12-01'}};
  window.test.listeners.forEach(fn=>fn());};window.setWeek(20);
window.seedTips=()=>{window.test.rows=Array.from({length:16},(_,i)=>({id:'tip-'+i,title:'Synthetic clinic tip '+i,
 content:'Synthetic guidance '+i+' '.repeat(2)+'Long clinic content. '.repeat(20),category:'Synthetic category',is_active:true,patient_id:i===15?'another-patient':null}));
 window.test.rows.push({id:'inactive',title:'Inactive forbidden',content:'Inactive forbidden',is_active:false});};window.seedTips();
const profile={recordId:'synthetic-patient',displayName:'Synthetic Patient'};
function App(){const location=useLocation(),navigate=useNavigate();const [version,setVersion]=useState(0);
const [patientId,setPatientId]=useState(profile.recordId);window.setPatientId=setPatientId;
window.resetDashboard=()=>setVersion(n=>n+1);
const activeNav=Object.keys(pageRoutes).find(key=>pageRoutes[key]===location.pathname)||'dashboard';
${navigateHandler}
return <div className="pwa-shell"><aside className="pwa-sidebar">${nav}</aside><main className="pwa-main">
<div className="pwa-content"><div className="pwa-content-inner">
<Dashboard key={version} profile={{...profile,recordId:patientId}}/>
<output data-route>{location.pathname}</output>
<div hidden data-shared-list><PatientHealthTipList tips={[]} isLoading={false} error=""/></div>
</div></div></main></div>;}
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`;
const mockClient=`export const supabase={from(table){if(table!=='health_tips')throw Error('Forbidden fixture query');
 const q={select(value){window.test.queries.push({table,select:value});return q;},eq(field,value){window.test.queries.push({field,value});return q;},order(){return q;},
 then(resolve){return new Promise(done=>{const finish=()=>done(window.test.error?{data:null,error:{message:'Synthetic load failure'}}:
 {data:window.test.rows.filter(row=>row.is_active),error:null});if(window.test.hold)window.resolveTips=finish;else finish();}).then(resolve);}};return q;},
 channel(){const c={on(type,filter,fn){window.reloadTips=fn;return c;},subscribe(){return c;}};return c;},removeChannel(){}};`;
const mockTracking=`import {useSyncExternalStore} from 'react';export function usePatientPregnancyTracking(){return useSyncExternalStore(
 fn=>{window.test.listeners.add(fn);return()=>window.test.listeners.delete(fn);},()=>window.test.pregnancy);}`;
const bundle=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},
 plugins:[{name:'offline-dashboard',enforce:'pre',resolveId(id){
  if(id.endsWith('dashboard-fixture.jsx'))return '\0dashboard-fixture.jsx';
  if(id.endsWith('/supabaseClient'))return '\0mock-client';
  if(id.endsWith('/usePatientPregnancyTracking'))return '\0mock-tracking';
  if(id==='@iconify/react')return '\0mock-icon';
 },load(id){if(id==='\0dashboard-fixture.jsx')return fixture;
  if(id==='\0mock-client')return mockClient;if(id==='\0mock-tracking')return mockTracking;
  if(id==='\0mock-icon')return 'import React from "react";export function Icon(props){return React.createElement("svg",{className:props.className,width:22,height:22,"aria-hidden":true})}';
 }}],build:{write:false,minify:false,lib:{entry:'dashboard-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(bundle)?bundle:[bundle]).flatMap(x=>x.output);
const code=outputs.find(x=>x.type==='chunk').code.replaceAll('</script','<\\/script');
const styles=[await read('src/styles/patient-PWA.css'),...outputs.filter(x=>x.fileName.endsWith('.css')).map(x=>x.source),await read('src/styles/patient-pwa-ui-system.css')].join('\n').replace(/@import\s+url\([^)]*\)\s*;/g,'');
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}${styles}</style><div id="root"></div><script type="module">${code}</script>`;
const server=createServer((req,res)=>{if(req.url.startsWith('/patient/')){res.setHeader('Content-Type','text/html');res.end(html);}else{res.writeHead(204);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,temporary=await mkdtemp(join(tmpdir(),'maternal-dashboard-ui-'));
let executable;
for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome']){
 try{await access(candidate);executable=candidate;break;}catch{/* Next installed browser. */}
}
assert.ok(executable,'Installed Chrome');
const browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
 '--remote-debugging-port=0',`--user-data-dir=${join(temporary,'profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));let socket;
try{
 let debugPort;for(let i=0;i<160&&!debugPort;i++){try{debugPort=(await readFile(join(temporary,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await pause();}}
 assert.ok(debugPort,'Isolated browser ready');
 const tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
 socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const pending=new Map();
 socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async(expression,label)=>{let ok;for(let i=0;i<100;i++){ok=await evaluate(expression);if(ok)break;await pause();}
  if(!ok&&label.includes('centered'))console.log(await evaluate("(()=>{const r=document.querySelector('.pwa-week-row'),c=r.querySelector('.is-active'),a=r.getBoundingClientRect(),b=c.getBoundingClientRect(),s=getComputedStyle(r);return {row:[a.left,a.width],card:[b.left,b.width],padding:[s.paddingLeft,s.paddingRight],scroll:r.scrollLeft,scrollWidth:r.scrollWidth,display:s.display,flex:getComputedStyle(c).flex,text:c.textContent};})()"));
  check(ok,label);};
 await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*','http://*.supabase.co/*']});
 await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/patient/dashboard`});
 await until("!!document.querySelector('.pwa-week-card.is-active')",'Actual Dashboard mounted');
 await until("JSON.parse(localStorage.getItem('maternal-daily-health-tip-v1:synthetic-patient'))?.dateKey==='2026-10-18'",'Today selection persisted as ID/date only');
 const initialTip=await evaluate("document.querySelector('.pwa-tip-copy h2').textContent");
 await cdp('Page.reload');await until("!!document.querySelector('.pwa-week-card.is-active')",'Reload actual Dashboard');
 await until(`document.querySelector('.pwa-tip-copy h2').textContent===${JSON.stringify(initialTip)}`,'Today selection survives a full browser reload');
 check(await evaluate("getComputedStyle(document.querySelector('.pwa-tip-actions button')).backgroundImage!=='none'"),'Existing tip action styling and CSS variables retained');
 for(const width of [320,360,375,390,412,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
  for(const week of [1,20,45]){
   await evaluate(`window.setWeek(${week});window.resetDashboard()`);
   await until(`(()=>{const r=document.querySelector('.pwa-week-row'),c=r?.querySelector('.is-active');if(!c||!c.textContent.includes('Week ${week}'))return false;const a=r.getBoundingClientRect(),b=c.getBoundingClientRect();return Math.abs(b.left+b.width/2-a.left-a.width/2)<2;})()`,`${width}px week ${week}: centered`);
   check(await evaluate("(()=>{const r=document.querySelector('.pwa-week-row').getBoundingClientRect(),c=document.querySelector('.pwa-week-card.is-active').getBoundingClientRect();return c.left>=r.left-1&&c.right<=r.right+1&&document.documentElement.scrollWidth<=innerWidth;})()"),`${width}px week ${week}: fully visible without page overflow`);
   check(await evaluate("!document.querySelector('.pwa-dashboard-shortcuts')&&document.querySelectorAll('.pwa-nav button').length===4"),'Quick Access absent; original navigation retained');
  }
 }
 await evaluate('window.setWeek(20);window.resetDashboard()');await pause(100);
 await evaluate('window.setWeek(21)');
 await until("document.querySelector('.pwa-week-card.is-active')?.textContent.includes('Week 21')",'Pregnancy data changes update the current week without remounting');
 await until("(()=>{const a=document.querySelector('.pwa-week-row').getBoundingClientRect(),b=document.querySelector('.pwa-week-card.is-active').getBoundingClientRect();return Math.abs(b.left+b.width/2-a.left-a.width/2)<2;})()",'Updated pregnancy week is recentered');
 await evaluate('window.setWeek(20)');await pause(100);
 await cdp('Emulation.setDeviceMetricsOverride',{width:375,height:800,deviceScaleFactor:1,mobile:true});
 await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 await evaluate("document.querySelector('.pwa-week-row').scrollIntoView({block:'center'})");await pause(300);
 const swipe=await evaluate("(()=>{const r=document.querySelector('.pwa-week-row'),b=r.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+50,left:r.scrollLeft};})()");
 await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:swipe.x,y:swipe.y,id:1}]});
 for(const distance of [25,50,80,110,140,165]){
  await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:swipe.x-distance,y:swipe.y,id:1}]});await pause(30);
 }
 await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await pause(500);
 if(!await evaluate(`Math.abs(document.querySelector('.pwa-week-row').scrollLeft-${swipe.left})>20`))console.log({swipe,after:await evaluate(`(()=>{const r=document.querySelector('.pwa-week-row');return {left:r.scrollLeft,width:r.clientWidth,max:r.scrollWidth-r.clientWidth,hit:document.elementFromPoint(${swipe.x},${swipe.y})?.outerHTML.slice(0,120),touch:getComputedStyle(r).touchAction,viewport:[innerWidth,innerHeight]};})()`)});
 check(await evaluate(`Math.abs(document.querySelector('.pwa-week-row').scrollLeft-${swipe.left})>20`),'Touch swipe moves the scroll strip');
 await evaluate("document.querySelector('[aria-label=\"Next week\"]').click()");
 await until("document.querySelector('.pwa-week-card.is-active')?.textContent.includes('Week 21')",'Existing next-week selection preserved');
 await evaluate("window.test.settled=true;document.querySelector('.pwa-tip-actions button').focus();document.querySelector('.pwa-tip-actions button').click()");
 await until("!!document.querySelector('dialog[open]')",'View All Tips opens native Dashboard modal');
 check(await evaluate("location.pathname==='/patient/dashboard'&&!document.body.textContent.includes('All Medication Reminders')"),'Preview stays on Dashboard and does not open medication view');
 check(await evaluate("document.querySelector('dialog').contains(document.activeElement)&&document.body.style.overflow==='hidden'"),'Initial focus and body-scroll lock');
 check(await evaluate("document.querySelectorAll('dialog .patient-reminder-health-tip-item').length===15&&!document.querySelector('dialog').textContent.includes('tip 15')&&!document.querySelector('dialog').textContent.includes('Inactive forbidden')&&!document.querySelector('dialog').textContent.includes('Legacy forbidden')&&document.querySelector('dialog header p').textContent==='15 active tips'"),'Accurate database count; other Patient, inactive and five legacy local tips excluded');
 for(const width of [320,360,375,390,412,1366]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:false});
  check(await evaluate("(()=>{const d=document.querySelector('dialog'),b=d.getBoundingClientRect(),l=d.querySelector('[role=region]');return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&l.scrollHeight>l.clientHeight;})()"),`${width}px: modal fits and tips scroll vertically`);
 }
 await cdp('Page.bringToFront');
 for(let i=0;i<4;i++)await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 check(await evaluate("document.querySelector('dialog').contains(document.activeElement)"),'Keyboard Tab remains in modal');
 await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await until("!document.querySelector('dialog')",'Escape closes preview');
 check(await evaluate("location.pathname==='/patient/dashboard'&&document.activeElement===document.querySelector('.pwa-tip-actions button')&&document.body.style.overflow!== 'hidden'"),'Close restores Dashboard focus and scrolling');
 await evaluate("document.querySelector('.pwa-tip-actions button').click()");await until("!!document.querySelector('dialog[open]')",'Reopen preview');
 await evaluate('history.back()');await until("!document.querySelector('dialog')",'Browser/gesture history Back dismisses preview first');
 check(await evaluate("location.pathname==='/patient/dashboard'"),'Back dismissal retains Dashboard route');
 await evaluate("document.querySelector('.pwa-tip-actions button').click()");await until("!!document.querySelector('dialog[open]')",'Reopen for explicit close');
 await evaluate("const b=document.querySelector('dialog button');b.click();b.click()");await until("!document.querySelector('dialog')",'Close button dismisses once');
 check(await evaluate("location.pathname==='/patient/dashboard'"),'Repeated close cannot navigate away');
 const warmTitle=await evaluate("document.querySelector('.pwa-tip-copy h2').textContent");
 await evaluate('window.test.hold=true;window.resetDashboard()');await pause(100);
 check(await evaluate(`document.querySelector('.pwa-tip-copy h2').textContent===${JSON.stringify(warmTitle)}&&!document.querySelector('.pwa-tip-copy p').textContent.includes('Loading')`),'Same-patient remount retains tips while refresh is held');
 await evaluate('window.test.error=true;window.resolveTips()');await pause(100);
 check(await evaluate(`document.querySelector('.pwa-tip-copy h2').textContent===${JSON.stringify(warmTitle)}&&!!window.cachedTips()`),'Transient refresh error retains successful same-patient tips');
 await evaluate('window.test.error=false;window.reloadTips()');await pause(100);
 await evaluate('window.clearTipSession();window.resolveTips()');await pause(100);
 check(await evaluate('window.cachedTips()===null'),'Logout cache generation rejects a late pre-logout result');
 await evaluate('window.test.rows=[];window.test.hold=true;window.resetDashboard()');await pause(50);
 await evaluate("document.querySelector('.pwa-tip-actions button').click()");await until("!!document.querySelector('dialog')",'Open while tips load');
 check(await evaluate("document.querySelector('dialog').textContent.includes('Loading health tips')"),'Explicit loading state');
 await evaluate('window.test.hold=false;window.resolveTips()');await until("document.querySelector('dialog').textContent.includes('No active daily health tips')",'Empty state without fake/default tips');
 await evaluate("document.querySelector('dialog button').click()");await until("!document.querySelector('dialog')",'Close empty preview');
 await evaluate('window.test.error=true;window.resetDashboard()');await pause(50);await evaluate("document.querySelector('.pwa-tip-actions button').click()");
 await until("!!document.querySelector('dialog [role=alert]')",'Loading failure shown without invented content');
 await evaluate("document.querySelector('dialog button').click()");await until("!document.querySelector('dialog')",'Close failed preview');
 for(const label of ['Medical Record','Appointments','Reminders','Dashboard']){
  await evaluate(`document.querySelector('.pwa-nav button[aria-label="${label}"]').click()`);
  await until(`document.querySelector('[data-route]').textContent===${JSON.stringify({'Medical Record':'/patient/medical-record',Appointments:'/patient/appointments',Reminders:'/patient/reminders',Dashboard:'/patient/dashboard'}[label])}`,'Original navigation destination: '+label);
 }
 check(await evaluate("window.test.queries.every(q=>q.table==='health_tips'||q.field==='is_active')&&window.test.errors.length===0"),'Read-only existing source and no browser errors');
 await evaluate('window.test.error=false;window.seedTips();window.resetDashboard()');await pause(100);
 await cdp('Emulation.setDeviceMetricsOverride',{width:375,height:800,deviceScaleFactor:1,mobile:true});
 await evaluate("document.querySelector('.pwa-journey-section').scrollIntoView({block:'center'})");await pause(100);
 const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(temporary,'dashboard.png'),Buffer.from(shot.data,'base64'));
 await evaluate("document.querySelector('.pwa-tip-actions button').click()");await until("!!document.querySelector('dialog[open]')",'Final preview screenshot');
 const modalShot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(temporary,'tips-preview.png'),Buffer.from(modalShot.data,'base64'));
 await evaluate("document.querySelector('dialog button').click()");await until("!document.querySelector('dialog')",'Close before daily rotation checks');
 const currentTitle=await evaluate("document.querySelector('.pwa-tip-copy h2').textContent");
 await evaluate("window.test.rows.push({id:'000-new-daily-tip',content:'Synthetic new guidance',title:'New eligible tip',is_active:true});window.reloadTips()");
 await pause(100);
 check(await evaluate(`document.querySelector('.pwa-tip-copy h2').textContent===${JSON.stringify(currentTitle)}`),'New tip publication leaves today selection stable');
 await evaluate("window.test.now=Date.parse('2026-10-18T15:59:59Z');document.dispatchEvent(new Event('visibilitychange'))");
 check(await evaluate(`document.querySelector('.pwa-tip-copy h2').textContent===${JSON.stringify(currentTitle)}`),'No rotation before Manila midnight');
 await evaluate("window.test.now=Date.parse('2026-10-18T16:00:00Z');window.dailyTick()");
 await until(`JSON.parse(localStorage.getItem('maternal-daily-health-tip-v1:synthetic-patient')).dateKey==='2026-10-19'&&document.querySelector('.pwa-tip-copy h2').textContent!==${JSON.stringify(currentTitle)}`,'Scheduled timer rotates at Manila midnight without database writes');
 const nextTitle=await evaluate("document.querySelector('.pwa-tip-copy h2').textContent");
 await evaluate('window.resetDashboard()');
 await until(`document.querySelector('.pwa-tip-copy h2').textContent===${JSON.stringify(nextTitle)}`,'New-day selection remains stable after remount');
 await evaluate("const saved=JSON.parse(localStorage.getItem('maternal-daily-health-tip-v1:synthetic-patient'));window.test.rows.find(t=>t.id===saved.tipId).is_active=false;window.reloadTips()");
 await until(`document.querySelector('.pwa-tip-copy h2').textContent!==${JSON.stringify(nextTitle)}`,'Archiving selected tip removes it from the active recommendation');
 await evaluate("window.test.rows.forEach(t=>t.display_schedule='Weekly');window.reloadTips()");
 await until("document.querySelector('.pwa-tip-copy p').textContent.includes('No active tips are scheduled for daily display')",'No daily candidates produces a suitable empty state');
 await evaluate("document.querySelector('.pwa-tip-actions button').click()");await until("!!document.querySelector('dialog[open]')",'Other approved schedules remain available in View All Tips');
 check(await evaluate("document.querySelectorAll('dialog .patient-reminder-health-tip-item').length===15&&[...document.querySelectorAll('dialog .patient-reminder-health-tip-meta')].every(e=>e.textContent.includes('Weekly'))"),'Preview preserves full authorized list and Doctor schedule labels');
 await evaluate("window.test.rows=[{id:'scoped-only',patient_id:'synthetic-patient',title:'Scoped old Patient',content:'Synthetic scoped content',is_active:true}];window.reloadTips()");
 await until("document.querySelectorAll('dialog .patient-reminder-health-tip-item').length===1&&document.querySelector('dialog').textContent.includes('Scoped old Patient')",'Own Patient-specific published tip is visible');
 await evaluate("window.test.hold=true;window.setPatientId('another-synthetic-patient')");
 await until("document.querySelectorAll('dialog .patient-reminder-health-tip-item').length===0&&!document.querySelector('dialog').textContent.includes('Scoped old Patient')",'Patient identity change immediately hides previous account tips before a new response');
 await evaluate("window.test.hold=false;window.resolveTips()");
 await until("document.querySelector('dialog').textContent.includes('No active daily health tips')",'Previous Patient response cannot populate another Patient preview');
 check(await evaluate("window.test.notifications.length===0&&window.test.errors.length===0"),'Daily rotation and preview never dispatch notifications or browser errors');
 console.log(`PASS: ${assertions} Dashboard assertions; six widths, actual components, mocked reads, touch/focus/Back/loading/empty/error checks. No live backend.`);
 console.log('Screenshot: '+join(temporary,'dashboard.png'));
}finally{socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));}
