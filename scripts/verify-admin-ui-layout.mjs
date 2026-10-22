// Actual Admin shell/profile/table/modal with synthetic identity and audit rows.
// Offline Chrome only; Auth/data hooks are replaced and external URLs blocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import postcss from 'postcss';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const auth = `export function useAdminAuth(){return {loading:false,error:null,isAdmin:true,user:{id:'offline-admin'},profile:{role:'Admin',account_status:'active'},refreshProfile:()=>{},identity:{displayName:'Synthetic Administrator With A Very Long Name',email:'synthetic.'+'long'.repeat(12)+'@example.test'},logout:async()=>{window.adminUi.logouts++}}}`;
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,useNavigate} from 'react-router-dom';
import AdminLayout from '${root}/src/components/admin/AdminLayout.jsx';
import AdminPageHeader from '${root}/src/components/admin/AdminPageHeader.jsx';
import {AuditTable,AuditEventDetails} from '${root}/src/pages/admin/AdminAuditLogs.jsx';
${['index.css','styles/adminDashboard.css','styles/adminUserManagement.css','styles/adminAppointmentOverview.css','styles/AdminReports.css','styles/AdminAuditLogs.css','styles/adminSystemSettings.css'].map(p=>`import '${root}/src/${p}';`).join('\n')}
window.adminUi={errors:[],logouts:0,details:0,pages:0};
window.addEventListener('error',event=>window.adminUi.errors.push(event.message));window.addEventListener('unhandledrejection',event=>window.adminUi.errors.push(String(event.reason)));
const row={id:'offline-event',created_at:'2026-10-16T02:00:00Z',actor_name:'Synthetic Administrator',actor_role:'Admin',module:'reports',action:'export',status:'success',entity_type:'synthetic_report',entity_id:'offline-report',description:'Synthetic audit description for offline rendering only.'};
function Page({title,audit=false,dashboard=false}){const navigate=useNavigate();window.adminUi.navigate=navigate;const[selected,setSelected]=React.useState(null);
return <>{dashboard?<header className='admin-hero'><div><h1>Dashboard</h1><p>Synthetic dashboard</p></div></header>:<AdminPageHeader title={title} subtitle='Synthetic page content'/>}
{audit?<AuditTable rows={[row,{...row,id:'offline-event-two',actor_name:'SyntheticAdministrator'.repeat(5),action:'deactivate',module:'appointment_management'}]} count={40} page={1} pageSize={10} onPageChange={()=>window.adminUi.pages++} onViewDetails={event=>{window.adminUi.details++;setSelected(event)}}/>:null}
<section data-synthetic-body style={{height:window.adminUi.short?0:1600}}>Synthetic content</section>
{selected?<AuditEventDetails event={selected} onClose={()=>setSelected(null)}/>:null}</>}
function App(){return <MemoryRouter initialEntries={['/admin/dashboard']}><Routes><Route element={<AdminLayout/>}>
${[['dashboard','Dashboard'],['user-management','User Management'],['appointment-overview','Appointment Overview'],['reports','Reports'],['audit-logs','Audit Logs'],['system-settings','System Settings'],['profile','Profile']].map(([route,title])=>`<Route path='/admin/${route}' element={<Page key='${route}' title='${title}' audit={${route==='audit-logs'}} dashboard={${route==='dashboard'}}/>}/>`).join('\n')}
</Route></Routes></MemoryRouter>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const result = await build({ root, configFile:false, logLevel:'error', define:{'process.env.NODE_ENV':'"production"'}, plugins:[{
  name:'offline-admin-ui',enforce:'pre',
  resolveId(id){
    if(id.endsWith('admin-ui-fixture.jsx'))return '\0admin-ui-fixture.jsx';
    if(/\/useAdminAuth(?:\.js)?$/.test(id))return '\0admin-ui-auth.js';
    if(/\/useRoleInactivityIdentity(?:\.js)?$/.test(id))return '\0admin-ui-inactivity.js';
    if(/\/useAdminAuditLogs(?:\.js)?$/.test(id))return '\0admin-ui-data.js';
    if(/\/supabaseClient(?:\.js)?$/.test(id))throw Error('Unexpected real Supabase dependency');
  },
  load(id){
    if(id==='\0admin-ui-fixture.jsx')return fixture;
    if(id==='\0admin-ui-auth.js')return auth;
    if(id==='\0admin-ui-inactivity.js')return 'export function useRoleInactivityIdentity(){}';
    if(id==='\0admin-ui-data.js')return 'export function useAdminAuditLogs(){throw Error("Data hook must not run in offline table fixture")}';
  },
  transform(source,id){if(id.replaceAll('\\','/').endsWith('/AdminAuditLogs.jsx'))return source+'\nexport {AuditTable,AuditEventDetails};';},
},react()],build:{write:false,minify:false,lib:{entry:'admin-ui-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(x=>x.output);
const css=postcss.parse(outputs.filter(x=>x.type==='asset'&&x.fileName.endsWith('.css')).map(x=>x.source).join('\n'));css.walkAtRules('import',rule=>rule.remove());
const code=outputs.find(x=>x.type==='chunk').code.replaceAll('</script','<\\/script');
const temp=await mkdtemp(join(tmpdir(),'maternal-admin-ui-')),html=join(temp,'fixture.html');
await writeFile(html,`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${code}</script>`);
let executable;
for(const path of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome']){try{await access(path);executable=path;break;}catch{/* Next installed browser. */}}
assert.ok(executable,'Installed Chrome required');
const browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${join(temp,'browser-profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));let socket,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
  let port;for(let n=0;n<100&&!port;n++){try{port=(await readFile(join(temp,'browser-profile/DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await pause();}}
  assert.ok(port,'Offline browser starts');
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;pending.delete(message.id);if(message.error)request.reject(Error(JSON.stringify(message.error)));else request.resolve(message.result);};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(Error('Browser command timeout: '+method));},5000).unref();});
  const evaluate=async expression=>{const response=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!response.exceptionDetails,JSON.stringify(response.exceptionDetails));return response.result.value;};
  const click=async selector=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await pause();};
  const escape=async()=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause();};
  await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});await cdp('Page.navigate',{url:pathToFileURL(html).href});
  for(let n=0;n<100;n++){if(await evaluate('!!window.adminUi?.navigate'))break;await pause();}
  check(await evaluate('!!window.adminUi?.navigate'),'Real Admin shell mounted with synthetic auth');
  const pages=['dashboard','user-management','appointment-overview','reports','audit-logs','system-settings'];
  const widths=[320,375,768,1024,1366,1600,1920];
  for(const width of widths){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});let baseline;
    for(const page of pages){
      await evaluate(`window.adminUi.navigate('/admin/${page}');window.scrollTo(0,0)`);await pause();
      const state=await evaluate(`(()=>{const e=document.querySelector('.admin-profile-card'),r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,count:document.querySelectorAll('.admin-profile-card').length,overflow:document.documentElement.scrollWidth>innerWidth,errors:window.adminUi.errors}})()`);
      baseline ||= state;
      check(state.count===1&&['x','y','width','height'].every(k=>Math.abs(state[k]-baseline[k])<1),`${width} ${page}: stable shared profile ${JSON.stringify({baseline,state})}`);
      check(state.x>=0&&state.right<=width&&!state.overflow,`${width} ${page}: contained page/profile`);
      check(state.errors.length===0,`${width} ${page}: no runtime errors`);
      await click('.admin-profile-card');
      const menu=await evaluate(`(()=>{const menu=document.querySelector('.admin-profile-dropdown'),r=menu.getBoundingClientRect(),pill=document.querySelector('.admin-profile-card').getBoundingClientRect(),name=menu.querySelector('strong').getBoundingClientRect(),email=menu.querySelector('small').getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom,pillBottom:pill.bottom,nameBottom:name.bottom,emailTop:email.top,nameRight:name.right,emailRight:email.right,overflow:menu.scrollWidth>menu.clientWidth,items:menu.querySelectorAll('[role=menuitem]').length,expanded:document.querySelector('.admin-profile-card').getAttribute('aria-expanded')}})()`);
      check(menu.expanded==='true'&&menu.items===3&&menu.y>=menu.pillBottom+9,`${width} ${page}: menu opens below trigger with all actions`);
      check(menu.x>=0&&menu.right<=width&&menu.bottom<=900&&!menu.overflow&&menu.nameRight<=menu.right&&menu.emailRight<=menu.right,`${width} ${page}: long identity/menu stays within viewport`);
      check(menu.emailTop>=menu.nameBottom+3,`${width} ${page}: name/email separated`);
      await escape();check(await evaluate(`!document.querySelector('.admin-profile-dropdown')&&document.activeElement===document.querySelector('.admin-profile-card')`),`${width} ${page}: Escape closes and restores focus`);
    }
    await evaluate(`window.adminUi.navigate('/admin/audit-logs');window.scrollTo(0,0)`);await pause();
    const table=await evaluate(`(()=>{const wrap=document.querySelector('.admin-audit-table-wrap');wrap.scrollLeft=wrap.scrollWidth;const table=wrap.querySelector('table'),cell=table.querySelector('td:last-child'),th=table.querySelector('th:last-child'),b=cell.querySelector('button'),r=b.getBoundingClientRect(),c=cell.getBoundingClientRect(),h=th.getBoundingClientRect(),w=wrap.getBoundingClientRect();return{rightGap:c.right-r.right,leftGap:r.left-c.left,headerLeft:h.left,cellLeft:c.left,buttonRight:r.right,wrapRight:w.right,wrapLeft:w.left,buttonLeft:r.left,scroll:wrap.scrollWidth>wrap.clientWidth,overflow:document.documentElement.scrollWidth>innerWidth,focusable:wrap.tabIndex,headers:[...table.querySelectorAll('th')].map(e=>e.textContent),rows:table.querySelectorAll('tbody tr').length}})()`);
    check(table.rightGap>=27&&table.leftGap>=17&&Math.abs(table.headerLeft-table.cellLeft)<1,`${width}: Details column alignment and padding`);
    check(table.buttonRight<=table.wrapRight&&table.buttonLeft>=table.wrapLeft&&!table.overflow,`${width}: Details buttons visible at end of contained scroller`);
    check(table.focusable===0&&table.rows===2&&table.headers.join(',')==='Timestamp,Actor,Role,Module,Action,Target,Description,Details',`${width}: accessible scrolling and all columns/rows preserved`);
    check(await evaluate(`(()=>{const rows=[...document.querySelectorAll('.admin-audit-table-wrap tbody tr')];return rows.every(row=>[...row.cells].every(cell=>{const r=cell.getBoundingClientRect();return [...cell.querySelectorAll('strong,.admin-audit-action,button')].every(e=>{const v=e.getBoundingClientRect();return v.left>=r.left&&v.right<=r.right})}))})()`),`${width}: long actor text and action badges stay in their columns`);
    if(width<1366){
      check(table.scroll,`${width}: table scrolls instead of page`);
      await evaluate(`(()=>{const region=document.querySelector('.admin-audit-table-wrap');region.scrollLeft=0;region.focus()})()`);
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
      await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await pause();
      check(await evaluate(`document.querySelector('.admin-audit-table-wrap').scrollLeft>0`),`${width}: keyboard can scroll the table`);
    }else{
      check(!table.scroll,`${width}: fitting desktop table must not overflow ${JSON.stringify(await evaluate(`(()=>{const e=document.querySelector('.admin-audit-table-wrap');return{available:e.clientWidth,content:e.scrollWidth,table:e.querySelector('table').getBoundingClientRect().width}})()`))}`);
    }
    await click('.admin-audit-details-button');check(await evaluate(`!!document.querySelector('[role=dialog]') && document.querySelector('.admin-audit-detail-description').textContent.includes('Synthetic audit description')`),`${width}: real View Details handler opens correct modal`);
    await escape();check(await evaluate(`!document.querySelector('.admin-audit-detail-dialog')&&document.activeElement===document.querySelector('.admin-audit-details-button')`),`${width}: details modal closes and restores button focus`);
    const pageCalls=await evaluate('window.adminUi.pages');
    await click('button[aria-label="Next page"]');
    check(await evaluate(`window.adminUi.pages===${pageCalls+1}`),`${width}: existing pagination callback retained`);
    await evaluate('window.scrollTo(0,0)');
    const y=await evaluate(`document.querySelector('.admin-profile-card').getBoundingClientRect().y`);
    await evaluate('window.scrollTo(0,180)');await pause();
    check(await evaluate(`Math.abs(document.querySelector('.admin-profile-card').getBoundingClientRect().y+window.scrollY-${y})<1`),`${width}: profile retains natural header scroll behavior`);
  }
  await evaluate(`window.scrollTo(0,0)`);await click('.admin-profile-card');await click('.admin-profile-dropdown button:nth-of-type(1)');
  check(await evaluate(`!!document.querySelector('h1')&&document.querySelector('h1').textContent==='Profile'&&!document.querySelector('.admin-profile-dropdown')`),'View Profile navigation retained');
  await click('.admin-profile-card');await click('.admin-profile-dropdown button:nth-of-type(2)');
  check(await evaluate(`document.querySelector('h1').textContent==='System Settings'&&!document.querySelector('.admin-profile-dropdown')`),'Settings navigation retained');
  await click('.admin-profile-card');await click('.admin-profile-dropdown button:nth-of-type(3)');
  check(await evaluate('window.adminUi.logouts===1&&!document.querySelector(".admin-profile-dropdown")'),'Logout invokes existing callback once');
  await click('.admin-profile-card');await click('.admin-page-header h1');check(await evaluate('!document.querySelector(".admin-profile-dropdown")'),'Outside click closes menu');
  await cdp('Emulation.setDeviceMetricsOverride',{width:320,height:375,deviceScaleFactor:1,mobile:false});
  await evaluate('window.scrollTo(0,0)');await click('.admin-profile-card');
  check(await evaluate(`(()=>{const e=document.querySelector('.admin-profile-dropdown'),r=e.getBoundingClientRect();return r.x>=0&&r.right<=320&&r.bottom<=375&&getComputedStyle(e).overflowY==='auto'})()`),'Short mobile viewport keeps dropdown bounded and scrollable');
  await escape();
  console.log(`PASS: ${pages.length*widths.length} Admin route/viewport cases and ${widths.length} audit table/modal cases; ${checks} assertions. Offline actual components, synthetic Auth/data; no authenticated Supabase testing.`);
}finally{socket?.close();browser.kill();}
