// Offline Chrome layout test. Uses the real shell/header JSX and current CSS;
// page bodies and data are synthetic. No Supabase, Auth or patient access.
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
const dashboard = (await readFile(join(root, 'src/pages/doctor/Doctor_Dashboard.jsx'), 'utf8')).replaceAll('\r\n', '\n');
const records = (await readFile(join(root, 'src/pages/doctor/Doctor_Medical_Records.jsx'), 'utf8')).replaceAll('\r\n', '\n');
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Source fragment exists: ' + start);
  return source.slice(a, b);
};
const controls = between(dashboard, 'function ProfileDropdown(', 'function DoctorIdentityRecovery(');
const actions = between(dashboard, '    const doctorPatientHeaderActions = (', '\n\n    switch (activePage)');
const shell = between(dashboard, '<main className={`doctor-main', '\n    </div>\n  );\n}\n\nexport default');
const medicalHeader = between(records, '<header className="doctor-patient-header-rail', '\n\n        <div className="doctor-patient-content-rail">');
assert.ok(!actions.includes('<DoctorHeaderControls'), 'Medical Record actions must not render a second pill');
assert.ok(shell.includes('{!isAppointmentVisitRoute ? ('), 'All workspace pages use the same shell profile');
const fixture = `
import React,{useState,useRef,useEffect,useId} from 'react';
import {createRoot} from 'react-dom/client';
${['index.css', 'styles/doctor-dashboard.css', 'styles/doctor-patients.css', 'styles/doctor-appointments.css', 'styles/doctor-reminder.css', 'styles/medical_records.css'].map(p => `import '${root}/src/${p}';`).join('\n')}
const Icon=props=><svg className={props.className} width='20' height='20' aria-hidden='true'/>;
const ProfileAvatarContent=({fallback})=><span>{fallback}</span>;
const getInitials=()=> 'SD';
const Suspense=React.Suspense;
const WorkspaceSectionFallback=()=>null;
const harness={errors:[],actions:0};window.alignment=harness;
window.addEventListener('error',event=>harness.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>harness.errors.push(String(event.reason)));
${controls}
function App(){
  const [activePage,setActivePage]=useState('dashboard');harness.setPage=setActivePage;
  const isAppointmentVisitRoute=false;
  const profile={displayName:'Synthetic Doctor',roleLabel:'Doctor'};
  const location={pathname:'/doctor/'+activePage,search:''};
  const navigateProfilePage=()=>{harness.actions++};
  const requestDoctorSignOut=()=>{harness.actions++};
  const profileNavigationFocusRef=useRef(false);
  const doctorIdentity={loading:false};
  const doctorPatientHeaderAction={label:'Edit Record',onClick:()=>{harness.actions++},disabled:false};
  ${actions}
  const headerActions=doctorPatientHeaderActions;
  const isLoadingPatient=false,isLoadingPatientRelated=false,patient={id:'synthetic-patient',full_name:'Synthetic Patient'},currentRecordForAction=null;
  const handleBackToPatients=()=>setActivePage('patients');
  const SendPatientNotificationAction=props=><button className={props.className} onClick={()=>{harness.actions++}}>Notify Patient</button>;
  function renderContent(){
    if(activePage==='medicalRecords')return <main className='medical-records-page medical-record-workspace'><div className='medical-records-content medical-record-ui-content'>${medicalHeader}<section data-body style={{height:1600}}>Synthetic record content</section></div></main>;
    const names={dashboard:['doctor-dashboard-home doctor-dashboard-home--responsive','doctor-topbar','Dashboard'],patients:['doctor-patients-list-page','doctor-patients-header','Patients'],appointments:['doctor-appointments-page','doctor-appointments-header','Appointments'],reminders:['doctor-reminder-page','doctor-dashboard-header doctor-reminder-header','Reminders']};
    const [pageClass,headerClass,title]=names[activePage];
    return <section className={pageClass}><header className={headerClass}><div className='doctor-page-title-block'><h2>{title}</h2><p>Synthetic workspace</p></div></header><section data-body style={{height:1600}}>Synthetic content</section></section>;
  }
  return <div className='doctor-dashboard'><aside className='doctor-sidebar'>Synthetic navigation</aside>${shell}</div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const result = await build({ root, configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [
  { name: 'offline-profile-alignment', enforce: 'pre', resolveId: id => id.endsWith('alignment-fixture.jsx') ? '\0alignment-fixture.jsx' : null,
    load: id => id === '\0alignment-fixture.jsx' ? fixture : null }, react(),
], build: { write: false, minify: false, lib: { entry: 'alignment-fixture.jsx', formats: ['es'] } } });
const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output);
const css = postcss.parse(outputs.filter(x => x.type === 'asset' && x.fileName.endsWith('.css')).map(x => x.source).join('\n'));
css.walkAtRules('import', rule => rule.remove());
const code = outputs.find(x => x.type === 'chunk').code.replaceAll('</script', '<\\/script');
const temporary = await mkdtemp(join(tmpdir(), 'maternal-profile-alignment-'));
const html = join(temporary, 'fixture.html');
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${code}</script>`);
let executable;
for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
  try { await access(candidate); executable = candidate; break; } catch { /* Next installed browser. */ }
}
assert.ok(executable, 'Chrome/Chromium is required');
const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, 'browser-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket, checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
try {
  let port;
  for (let n = 0; n < 100 && !port; n++) { try { port = (await readFile(join(temporary, 'browser-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(); } }
  assert.ok(port, 'Offline browser starts');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return; pending.delete(message.id); if(message.error)request.reject(Error(JSON.stringify(message.error)));else request.resolve(message.result); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if(pending.delete(id))reject(Error('Browser command timeout: '+method)); },5000).unref();
  });
  const evaluate = async expression => { const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails)); return response.result.value; };
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  await cdp('Page.navigate', { url: pathToFileURL(html).href });
  for(let n=0;n<100;n++){if(await evaluate('!!window.alignment?.setPage'))break;await pause();}
  check(await evaluate('!!window.alignment?.setPage'), 'Fixture mounted');
  const widths = [320,390,768,900,901,1024,1440,1920];
  for (const width of widths) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
    let baseline;
    for (const page of ['dashboard','patients','appointments','medicalRecords','reminders','patients']) {
      await evaluate(`window.alignment.setPage('${page}')`); await pause();
      const state = await evaluate(`(()=>{const pill=document.querySelector('.doctor-profile-card'),main=document.querySelector('.doctor-main');main.scrollTop=0;const r=pill.getBoundingClientRect(),s=getComputedStyle(document.querySelector('.doctor-global-profile-slot'));const rect=e=>{const v=e.getBoundingClientRect();return{x:v.x,y:v.y,right:v.right,bottom:v.bottom,width:v.width,height:v.height}};return{...rect(pill),count:document.querySelectorAll('.doctor-profile-card').length,position:s.position,controls:[...document.querySelectorAll('.doctor-edit-record-button,.mr-header-notification-action')].map(rect),heading:rect(document.querySelector('h1,h2')),overflow:document.documentElement.scrollWidth>innerWidth,errors:window.alignment.errors}})()`);
      check(state.count===1, `${width} ${page}: exactly one profile`);
      baseline ||= state;
      check(['x','y','width','height'].every(key=>Math.abs(state[key]-baseline[key])<1), `${width} ${page}: profile stays aligned`);
      check(state.x>=0 && state.right<=width+1 && !state.overflow, `${width} ${page}: fits viewport`);
      check(state.position===(width<=900?'static':'absolute'), `${width} ${page}: existing responsive scroll behavior`);
      const overlap = other => state.x<other.right && state.right>other.x && state.y<other.bottom && state.bottom>other.y;
      check(!overlap(state.heading) && state.controls.every(rect=>!overlap(rect)), `${width} ${page}: no heading/action overlap`);
      check(state.errors.length===0, `${width} ${page}: no runtime errors`);
      await evaluate(`document.querySelector('.doctor-profile-card').click()`); await pause();
      check(await evaluate(`document.querySelector('.doctor-profile-card').getAttribute('aria-expanded')==='true' && !!document.querySelector('.doctor-profile-dropdown')`), `${width} ${page}: dropdown opens`);
      const dropdown = await evaluate(`(()=>{const r=document.querySelector('.doctor-profile-dropdown').getBoundingClientRect();return{x:r.x,right:r.right}})()`);
      check(dropdown.x>=0 && dropdown.right<=width+1, `${width} ${page}: dropdown fits viewport`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await pause();
      check(await evaluate(`!document.querySelector('.doctor-profile-dropdown')`), `${width} ${page}: Escape closes dropdown`);
    }
  }
  console.log(`PASS: ${widths.length * 6} offline browser page/viewport cases; ${checks} assertions. Real shell/profile JSX and Medical Records header; synthetic page bodies, external network blocked.`);
} finally { socket?.close(); browser.kill(); }
