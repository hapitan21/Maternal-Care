/* global process */
// Render the real shared pagination with Doctor/Staff styles; no backend is imported.
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

const root=fileURLToPath(new URL("..",import.meta.url)).replaceAll("\\","/");
const sizes={};
for(const role of ['doctor','staff']){
 const source=await readFile(join(root,`src/pages/${role}/${role==='doctor'?'Doctor':'Staff'}_Appointments.jsx`),'utf8');
 sizes[role]=JSON.parse(source.match(/const appointmentPageSizes = (\[[^\]]+\])/)[1]);
 assert.deepEqual(sizes[role],[10,15],role+' existing page-size options');
}
postcss.parse(await readFile(join(root,'src/styles/appointment-ui-system.css'),'utf8'));
const audit=process.argv.includes('--audit');
const baselinePath=process.argv.find(argument=>argument.startsWith('--baseline-css='))?.slice('--baseline-css='.length);
const baselineCss=baselinePath?await readFile(baselinePath,'utf8'):undefined;
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import '${root}/src/index.css';import '${root}/src/styles/doctor-dashboard.css';import '${root}/src/styles/staff-dashboard.css';import '${root}/src/styles/staff-doctor-parity.css';
import '${root}/src/styles/doctor-appointments.css';import '${root}/src/styles/appointment-ui-system.css';import '${root}/src/styles/staff-appointments.css';
import {AppointmentPagination,AppointmentPageHeader} from '${root}/src/components/appointments/AppointmentUi.jsx';
const sizes=${JSON.stringify(sizes)},root=createRoot(document.getElementById('root')),pause=(ms=80)=>new Promise(resolve=>setTimeout(resolve,ms));
let assertions=0,failures=[],reports=[];const $=selector=>document.querySelector(selector);
const check=(condition,message)=>{assertions++;if(!condition)failures.push(message)};
function Fixture({role}){
 const [size,setSize]=useState(sizes[role][0]),[page,setPage]=useState(1);const pages=Math.ceil(30/size);
 return <div className={'doctor-dashboard '+(role==='staff'?'staff-dashboard-shell':'')}><aside className="doctor-sidebar">Sidebar</aside><main className="doctor-main"><div className="doctor-content">
 <section className={role+'-appointments-page appointment-workspace appointment-workspace--'+role}>
 <AppointmentPageHeader title="Appointments" subtitle="Manage scheduling, arrivals, and appointment status." tabs={['All']} activeTab="All" onTabChange={()=>{}} className={role+'-appointments-header '+(role==='staff'?'staff-section-header':'')} titleBlockClassName={role+'-appointments-title-block'} tabsClassName={role+'-appointments-tabs'}/>
 <section className={role+'-appointments-table-card appointment-ui-table-card'}>
 <div style={{minHeight:100,padding:20}}>Table content</div>
 <AppointmentPagination className={role+'-appointments-pagination'} currentPage={Math.min(page,pages)} pageSize={size} pageSizes={sizes[role]} totalItems={30} totalPages={pages} onPageChange={setPage} onPageSizeChange={setSize}/>
 </section></section></div></main></div>;
}
async function render(role){flushSync(()=>root.render(<Fixture key={role} role={role}/>));await pause(300)}
function metrics(role){
 const select=$('select[aria-label="Rows per page"]'),pagination=$('.appointment-ui-pagination'),style=getComputedStyle(select),rect=select.getBoundingClientRect();
 const label=select.closest('label'),controls=pagination.lastElementChild,info=pagination.firstElementChild;
 const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
 const glyph=context.measureText(select.value).width,padLeft=parseFloat(style.paddingLeft),padRight=parseFloat(style.paddingRight);
 // Reserve a conservative 20px inside the native control for its dropdown arrow.
 const textSpace=select.clientWidth-padLeft-padRight-20;
 const overlap=(first,second)=>{const a=first.getBoundingClientRect(),b=second.getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top};
 check(textSpace>=glyph+2,role+' '+select.value+' full glyph width plus native arrow clearance');
 check(rect.width>=52&&rect.width<=60,role+' compact selector width');
 check(style.appearance==='auto'||style.appearance==='menulist',role+' native select appearance preserved');
 check(select.scrollWidth<=select.clientWidth,role+' select has no horizontal content overflow');
 check(rect.height>=32&&rect.height<=36&&parseFloat(style.paddingTop)===parseFloat(style.paddingBottom),role+' vertically centred compact control');
 check(!overlap(label,info)&&!overlap(label,controls)&&!overlap(info,controls),role+' pagination groups do not overlap');
 const buttons=[...controls.querySelectorAll('button')],page=controls.querySelector('span'),previous=buttons[0].getBoundingClientRect(),next=buttons[1].getBoundingClientRect(),count=page.getBoundingClientRect();
 check(previous.right<=count.left&&count.right<=next.left,role+' Previous / page count / Next order and clearance');
 check(Math.abs((previous.top+previous.bottom)/2-(next.top+next.bottom)/2)<1&&Math.abs((previous.top+previous.bottom)/2-(count.top+count.bottom)/2)<1,role+' navigation vertically aligned');
 check(pagination.scrollWidth<=pagination.clientWidth,role+' pagination has no horizontal overflow');
 check(document.documentElement.scrollWidth<=innerWidth,role+' page has no horizontal overflow');
 const bounds=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
 reports.push({role,value:select.value,width:rect.width,height:rect.height,padLeft,padRight,glyph:+glyph.toFixed(2),textSpace,footerWidth:pagination.clientWidth,footerScrollWidth:pagination.scrollWidth,pageWidth:document.documentElement.scrollWidth,geometry:[pagination,info,label,select,controls,...buttons,page].map(bounds)});
}
try{for(const role of ['doctor','staff']){
 await render(role);check(JSON.stringify([...$('select').options].map(option=>Number(option.value)))===JSON.stringify(sizes[role]),role+' options unchanged');metrics(role);
 $('button[aria-label="Next appointments page"]').click();await pause();check($('.appointment-ui-pagination').textContent.includes('Showing 11-20 of 30')&&$('[aria-label="Page 2 of 3"]'),role+' Next retains pagination behavior');
 const select=$('select');select.value='15';select.dispatchEvent(new Event('change',{bubbles:true}));await pause();metrics(role);
 check($('.appointment-ui-pagination').textContent.includes('Showing 16-30 of 30')&&$('[aria-label="Page 2 of 2"]'),role+' selecting 15 changes displayed range and total pages');
 check($('button[aria-label="Next appointments page"]').disabled,role+' last page disables Next');
 $('button[aria-label="Previous appointments page"]').click();await pause();check($('[aria-label="Page 1 of 2"]')&&$('button[aria-label="Previous appointments page"]').disabled,role+' Previous retains pagination behavior');
 select.value='10';select.dispatchEvent(new Event('change',{bubbles:true}));await pause();check(select.value==='10'&&$('[aria-label="Page 1 of 3"]'),role+' 10 can be reselected');
 }
 window.inspectRows=async(role)=>{await render(role)};window.rowsResult={assertions,failures,reports};
}catch(error){window.rowsResult={assertions,failures:[...failures,error.stack],reports}}
`;
const result=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'offline-rows-selector',enforce:'pre',resolveId(id){if(id.endsWith('rows-selector-test.jsx'))return '\0rows-selector-test.jsx'},load(id){if(id==='\0rows-selector-test.jsx')return fixture;if(baselineCss&&id.replaceAll('\\','/').endsWith('/src/styles/appointment-ui-system.css'))return baselineCss}},react()],build:{write:false,minify:false,lib:{entry:'rows-selector-test.jsx',formats:['es']}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(output=>output.output),code=outputs.find(output=>output.type==='chunk').code.replaceAll('</script','<\\/script');
const css=outputs.filter(output=>output.type==='asset'&&output.fileName.endsWith('.css')).map(output=>output.source).join('\n');
const offlineCss=postcss.parse(css);
offlineCss.walkAtRules('import',rule=>rule.remove());
const temporary=await mkdtemp(join(tmpdir(),'maternal-rows-selector-browser-')),html=join(temporary,'fixture.html');
await writeFile(html,`<meta name="viewport" content="width=device-width, initial-scale=1"><style>${offlineCss}</style><div id="root"></div><script type="module">${code}</script>`);
const candidates=process.env.HEADLESS_BROWSER?[process.env.HEADLESS_BROWSER]:['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'];
let executable;for(const candidate of candidates){try{await access(candidate);executable=candidate;break}catch{/* Try next installed browser. */}}
assert.ok(executable,'Set HEADLESS_BROWSER to installed Chrome/Chromium');
const browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${join(temporary,'browser-profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));let socket,cdp;
try{
 let port;for(let attempt=0;attempt<100&&!port;attempt++){try{port=(await readFile(join(temporary,'browser-profile/DevToolsActivePort'),'utf8')).split('\n')[0]}catch{await pause()}}
 assert.ok(port,'Offline Chrome starts');const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});let sequence=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;pending.delete(message.id);if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result)};
 cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(new Error('Browser command timeout: '+method))},5000).unref()});
 await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});let total=0,failed=0;const observations=[];
 for(const width of [1440,1024,768,375]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:pathToFileURL(html).href});let observation;
  for(let attempt=0;attempt<150&&!observation;attempt++){await pause();observation=(await cdp('Runtime.evaluate',{expression:'window.rowsResult',returnByValue:true})).result.value}
  assert.ok(observation,'Rows fixture completes');total+=observation.assertions;failed+=observation.failures.length;
  observations.push({width,...observation});
  console.log(`${width}px: ${observation.assertions} assertions, ${observation.failures.length} failures; ${JSON.stringify(observation.reports.map(({geometry,...report})=>({...report,groups:geometry.length})))}`);observation.failures.forEach(failure=>console.error(failure));
  for(const role of ['doctor','staff']){
   await cdp('Runtime.evaluate',{expression:`window.inspectRows('${role}')`,awaitPromise:true});const screenshot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(temporary,`${role}-${width}.png`),Buffer.from(screenshot.data,'base64'));
   const rect=(await cdp('Runtime.evaluate',{expression:"(()=>{const r=document.querySelector('.appointment-ui-pagination').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:2}})()",returnByValue:true})).result.value;
   if(rect.x>=0&&rect.width<=width){const crop=await cdp('Page.captureScreenshot',{format:'png',clip:rect});await writeFile(join(temporary,`${role}-footer-${width}.png`),Buffer.from(crop.data,'base64'));}
  }
 }
 await writeFile(join(temporary,'results.json'),JSON.stringify(observations,null,2));
 console.log(`Browser total: ${total} assertions, ${failed} failures. No backend imported; HTTP(S) blocked. Screenshots and results: ${temporary}`);if(!audit)assert.equal(failed,0,'Rows selector regressions pass');
}finally{if(cdp)await cdp('Browser.close').catch(()=>browser.kill());else browser.kill();socket?.close()}
