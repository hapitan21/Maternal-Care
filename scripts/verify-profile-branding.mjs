// Offline Chrome: actual profile-row JSX, AdminSidebar and shared logo/CSS.
// Icon SVGs are inert stand-ins; compare actual Iconify names and computed styles.
// No authentication or Supabase access.
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
const read = async path => (await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n');
const doctor = await read('src/pages/doctor/Doctor_ViewProfile.jsx');
const staff = await read('src/pages/staff/Staff_ViewProfile.jsx');
const fragment = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Exact JSX fragment: ' + start);
  return source.slice(a, b);
};
const gender = (source, actor) => fragment(source, `    {\n      icon:\n        String(${actor}.gender`, '    {\n      icon: "solar:calendar-linear"').trim().replace(/,$/, '');
// Doctor uses optional chaining for nullable personal information.
const doctorItem = gender(doctor.replaceAll('personal?.gender', 'personal.gender'), 'personal');
const staffItem = gender(staff, 'profile');
assert.ok(!staffItem.includes('image:'), 'Staff Gender uses Iconify rather than PNG');
const row = (source, name) => fragment(source, 'function ProfileInfoRow(', 'function ProfileDetailRow(').replace('function ProfileInfoRow(', `function ${name}(`);
const logoSource = await read('src/components/common/MaternalCareLogo.jsx');
assert.ok(logoSource.includes('"/images/maternal-care-logo.png"'), 'Canonical shared logo source');
const png = await readFile(join(root, 'public/images/maternal-care-logo.png'));
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
import AdminSidebar from '${root}/src/components/admin/AdminSidebar.jsx';
${['index.css','styles/doctor-dashboard.css','styles/doctor-viewprofile.css','styles/staff-dashboard.css','styles/staff-doctor-parity.css','styles/staff-viewprofile.css','styles/adminLayout.css'].map(p=>`import '${root}/src/${p}';`).join('\n')}
const Icon=({icon})=><svg data-icon={icon} viewBox='0 0 24 24'><path d='M8 4h8v16H8z'/></svg>;
const displayValue=value=>value||'Not provided';
const recordedValue=displayValue;
${row(doctor,'DoctorRow')}
${row(staff,'StaffRow')}
function App(){const [gender,setGender]=React.useState('Female');window.branding.setGender=setGender;const personal={gender},profile={gender};
return <><div className='doctor-dashboard'><main className='doctor-main'><section className='doctor-profile-page' data-doctor><DoctorRow item={${doctorItem}}/></section></main></div>
<div className='doctor-dashboard staff-dashboard-shell'><main className='doctor-main'><section className='doctor-profile-page staff-profile-page' data-staff><StaffRow item={${staffItem}}/></section></main></div>
<MemoryRouter><div className='admin-shell'><AdminSidebar open onClose={()=>window.branding.clicks++} drawerId='test-admin-navigation'/><main className='admin-main'>Synthetic Admin content</main></div></MemoryRouter></>}
window.branding={clicks:0,errors:[]};window.addEventListener('error',event=>window.branding.errors.push(event.message));window.addEventListener('unhandledrejection',event=>window.branding.errors.push(String(event.reason)));
createRoot(document.getElementById('root')).render(<App/>);
`;
const result = await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
  name:'offline-branding',enforce:'pre',
  resolveId:id=>id.endsWith('branding-fixture.jsx')?'\0branding-fixture.jsx':null,
  load:id=>id==='\0branding-fixture.jsx'?fixture:null,
  transform(source,id){
    if(id.replaceAll('\\','/').endsWith('/common/MaternalCareLogo.jsx'))return source.replace('/images/maternal-care-logo.png','data:image/png;base64,'+png.toString('base64'));
  },
},react()],build:{write:false,minify:false,lib:{entry:'branding-fixture.jsx',formats:['es']}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(x=>x.output);
const css=postcss.parse(outputs.filter(x=>x.type==='asset'&&x.fileName.endsWith('.css')).map(x=>x.source).join('\n'));
css.walkAtRules('import',rule=>rule.remove());
const code=outputs.find(x=>x.type==='chunk').code.replaceAll('</script','<\\/script');
const temp=await mkdtemp(join(tmpdir(),'maternal-profile-branding-')),html=join(temp,'fixture.html');
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
  socket=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;pending.delete(message.id);if(message.error)request.reject(Error(JSON.stringify(message.error)));else request.resolve(message.result);};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(Error('Browser command timeout: '+method));},5000).unref();});
  const evaluate=async expression=>{const response=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!response.exceptionDetails,JSON.stringify(response.exceptionDetails));return response.result.value;};
  await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});
  await cdp('Page.navigate',{url:pathToFileURL(html).href});
  for(let n=0;n<100;n++){if(await evaluate('!!window.branding?.setGender'))break;await pause();}
  check(await evaluate('!!window.branding?.setGender'),'Fixture mounted');
  for(const width of [320,390,768,1024,1440]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    for(const [value,icon] of [['Female','mdi:gender-female'],['Male','mdi:gender-male'],['','mdi:gender-male-female']]){
      await evaluate(`window.branding.setGender(${JSON.stringify(value)})`);await pause();
      check(await evaluate(`!!document.querySelector('[data-doctor] .doctor-profile-row-icon') && !!document.querySelector('[data-staff] .doctor-profile-row-icon')`),'Both actual profile rows rendered');
      const states=await evaluate(`['[data-doctor]','[data-staff]'].map(selector=>{const e=document.querySelector(selector+' .doctor-profile-row-icon'),svg=e.querySelector('svg'),style=getComputedStyle(e),r=getComputedStyle(e.parentElement),s=getComputedStyle(svg);return{icon:svg.dataset.icon,image:!!e.querySelector('img'),width:style.width,height:style.height,color:style.color,background:style.backgroundColor,radius:style.borderRadius,align:style.alignItems,justify:style.justifyContent,rowAlign:r.alignItems,gap:r.gap,svgWidth:s.width,svgHeight:s.height,fill:s.fill,stroke:s.stroke,strokeWidth:s.strokeWidth}})`);
      check(states.every(x=>x.icon===icon&&!x.image),`${width} ${value||'unknown'}: same gender icon and library`);
      check(JSON.stringify(states[0])===JSON.stringify(states[1]),`${width} ${value||'unknown'}: exact computed icon/container/spacing parity`);
      check(states[0].width==='36px'&&states[0].svgWidth==='18px',`${width}: original compact sizing`);
    }
    const logo=await evaluate(`(()=>{const img=document.querySelector('.admin-brand img'),sidebar=document.querySelector('.admin-sidebar'),r=img.getBoundingClientRect(),s=sidebar.getBoundingClientRect();return{complete:img.complete,natural:img.naturalWidth,width:r.width,height:r.height,left:r.left,right:r.right,sidebarLeft:s.left,sidebarRight:s.right,alt:img.alt,links:sidebar.querySelectorAll('nav a').length,old:!!document.querySelector('.admin-brand strong,.admin-brand svg')}})()`);
    check(logo.complete&&logo.natural===png.readUInt32BE(16),'Approved PNG decoded');
    check(logo.width===144&&Math.abs(logo.width/logo.height-png.readUInt32BE(16)/png.readUInt32BE(20))<0.01,`${width}: original logo aspect ratio and responsive sidebar sizing`);
    check(logo.left>=logo.sidebarLeft&&logo.right<=logo.sidebarRight,`${width}: logo fits open sidebar`);
    check(logo.alt==='Maternal Care'&&!logo.old&&logo.links===6,`${width}: accessible shared brand and all navigation preserved`);
    check(await evaluate('window.branding.errors.length===0'),`${width}: no browser runtime errors`);
  }
  await evaluate(`document.querySelector('.admin-nav a').click()`);await pause();
  check(await evaluate('window.branding.clicks===1'),'Existing navigation callback retained');
  console.log(`PASS: 15 gender/viewport comparisons and 5 Admin sidebar viewports; ${checks} assertions. Offline synthetic browser fixture, Iconify identifiers plus computed CSS, no authenticated app testing.`);
}finally{socket?.close();browser.kill();}
