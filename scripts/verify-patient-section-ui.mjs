// Actual Patient shell, pages, profile menu and browser reminder effect. Synthetic reads/APIs only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import postcss from "postcss";

const root = fileURLToPath(new URL("../", import.meta.url));
let assertions = 0;
const check = (value, label) => { assert.ok(value, label); assertions++; };
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import PatientPWA from ${JSON.stringify(join(root, "src/pages/patient/Patient_PWA.jsx").replaceAll("\\", "/"))};
window.scrollPatient=top=>document.querySelector('.pwa-main').scrollTo({top,behavior:'instant'});
window.test={errors:[],reads:[],notifications:[],callbacks:[],initialRestoration:history.scrollRestoration};
window.addEventListener('error',e=>window.test.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.test.errors.push(String(e.reason)));
window.test.patient={id:'synthetic-patient',user_id:'synthetic-user',full_name:'Synthetic Patient',account_status:'active',
 patient_id:'SYNTHETIC',expected_delivery_date:'2030-12-01'};
window.test.obstetric={id:'synthetic-obstetric',patient_id:'synthetic-patient',gravida:2,para:1,full_term:1,preterm:0,
 abortion_miscarriage:0,living_children:1,last_menstrual_period:'2030-02-24',expected_delivery_date:'2030-12-01'};
window.test.medicalRecords=[{id:'synthetic-old',patient_id:'synthetic-patient',type:'Initial Visit',uploaded_at:'2026-10-01T02:00:00Z',
 form_data:{recordStatus:'completed',visitFormType:'initial',chiefComplaint:'Synthetic earlier complaint',diagnosis:'Synthetic earlier diagnosis'}},
 {id:'synthetic-new',patient_id:'synthetic-patient',type:'Follow-Up Visit',uploaded_at:'2026-10-18T02:00:00Z',
 form_data:{recordStatus:'completed',visitFormType:'follow_up',chiefComplaint:'Synthetic recent complaint',diagnosis:'Synthetic recent diagnosis'}}];
const now=Date.now();window.test.reminders=[{id:'synthetic-reminder',patient_id:'synthetic-patient',schedule_id:'synthetic-schedule',
 reminder_type:'appointment',title:'Synthetic visit',message:'Synthetic appointment reminder',status:'sent',sent_at:new Date(now-1000).toISOString(),
 remind_at:new Date(now-1000).toISOString(),schedule:{id:'synthetic-schedule',patient_id:'synthetic-patient',
 title:'Synthetic visit',start_time:new Date(now+3600000).toISOString(),end_time:new Date(now+5400000).toISOString(),status:'scheduled'}}];
window.Notification=class {static permission='granted';constructor(title,options){window.test.notifications.push({title,options});}};
Object.defineProperty(navigator,'serviceWorker',{value:{getRegistration:async()=>({showNotification:async(title,options)=>{
 window.test.notifications.push({title,options});}})},configurable:true});
const fixtureRoot=createRoot(document.getElementById('root'));window.unmountFixture=()=>fixtureRoot.unmount();
fixtureRoot.render(<BrowserRouter><PatientPWA/></BrowserRouter>);`;
const mockClient = `
function query(source,rpc=false){let single=false;const q={};
for(const method of ['select','eq','neq','in','order','limit','gte','lte','gt','lt','or','is','range'])q[method]=()=>q;
q.maybeSingle=q.single=()=>{single=true;return q;};
q.then=resolve=>{window.test.reads.push(source);let data=[];
if(source==='get_current_patient_account_status'||source==='get_patient_own_record')data=window.test.patient;
else if(source==='get_my_patient_profile_summary')data={patient:window.test.patient,obstetric:window.test.obstetric};
else if(source==='profiles')data={id:'synthetic-user',role:'patient',full_name:'Synthetic Patient'};
else if(source==='patient_obstetric_history')data=window.test.obstetric;
else if(source==='medical_records')data=window.test.medicalRecords;
else if(source==='reminders')data=window.test.reminders;
else if(source==='health_tips')data=window.test.tipRows||Array.from({length:20},(_,i)=>({id:'synthetic-tip-'+i,content:'Synthetic clinic guidance',title:'Synthetic tip '+i,category:'Nutrition',is_active:true}));
else if(rpc)throw Error('Unexpected fixture RPC: '+source);
if(single&&Array.isArray(data))data=data[0]||null;
return Promise.resolve({data,error:null}).then(resolve);};return q;}
export const supabase={auth:{getUser:async()=>({data:{user:{id:'synthetic-user',email:'synthetic@example.invalid'}},error:null}),
getSession:async()=>({data:{session:{user:{id:'synthetic-user'}}},error:null}),
onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
from:name=>query(name),rpc:name=>query(name,true),channel(){const c={on(type,filter,fn){window.test.callbacks.push({filter,fn});return c;},
subscribe(){return c;}};return c;},removeChannel(){}};`;
const mocks = {
  "/supabaseClient": mockClient,
  "/PatientPushNotificationSettings": "export default function PushSettings(){return null}",
  "/PatientBookAppointment": "export default function Booking(){return null}",
  "/usePatientPregnancyTracking": `const state={status:'ready',tracking:{hasCurrentPregnancy:true,week:20,
trimester:{label:'Synthetic trimester'},weeksRemaining:20,progressPercent:50,expectedDeliveryDate:'2030-12-01'}};
export const usePatientPregnancyTracking=()=>state;`,
  "/PatientPwaStatus": "export default function Status(){return null}",
  "/patientNativePush": `export const isNativeAndroidPushAvailable=()=>false;
export const beginPatientNativePushSession=()=>{};export const endPatientNativePushSession=()=>{};
export const cleanupPatientNativePushBeforeLogout=async()=>{};export const reconcilePatientNativePushRegistration=async()=>{};`,
  "/patientNativePushNavigation": `export const getPatientNativePushNavigationSnapshot=()=>0;
export const subscribePatientNativePushNavigation=()=>()=>{};export const hasPendingPatientNativePushNavigation=()=>false;
export const acknowledgePatientNativePushNavigation=()=>{};export const cancelPatientNativePushNavigationBeforeLogout=()=>{};
export const clearPatientNativePushNavigation=()=>{};export const consumePatientNativePushNavigation=async()=>{};`,
};
const bundle = await build({ root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "synthetic-patient-sections", enforce: "pre", resolveId(id) {
    if (id.endsWith("section-fixture.jsx")) return "\0section-fixture.jsx";
    const match = Object.keys(mocks).find(key => id.endsWith(key));
    if (match) return "\0mock" + match;
    if (id === "@iconify/react") return "\0mock-icon";
  }, load(id) {
    if (id === "\0section-fixture.jsx") return fixture;
    if (id.startsWith("\0mock/")) return mocks[id.slice(5)];
    if (id === "\0mock-icon") return 'import React from "react";export function Icon(p){return React.createElement("svg",{className:p.className,width:22,height:22,"aria-hidden":true})}';
  } }], build: { write: false, minify: false, lib: { entry: "section-fixture.jsx", formats: ["es"] },
    rollupOptions: { output: { codeSplitting: false } } } });
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(item => item.output);
const css = outputs.filter(item => item.fileName.endsWith(".css")).map(item => item.source).join("\n");
postcss.parse(css);check(true, "Changed and actual page styles parse");
const assets = new Map(outputs.map(item => ["/" + item.fileName, item.type === "chunk" ? item.code : item.source]));
const logo = await readFile(join(root, "public/images/maternal-care-logo.png"));
const entry = outputs.find(item => item.type === "chunk" && item.isEntry).fileName;
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.replace(/@import\s+url\([^)]*\)\s*;/g, "")}</style><div id="root"></div><script type="module" src="/${entry}"></script>`;
const server = createServer((req, res) => {
  if (req.url === "/images/maternal-care-logo.png") { res.setHeader("Content-Type", "image/png");res.end(logo); }
  else if (assets.has(req.url)) { res.setHeader("Content-Type", "text/javascript");res.end(assets.get(req.url)); }
  else if (req.url.startsWith("/patient/")) { res.setHeader("Content-Type", "text/html");res.end(html); }
  else { res.writeHead(204);res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const temporary = await mkdtemp(join(tmpdir(), "maternal-patient-sections-"));
let executable;
for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
  try { await access(candidate); executable = candidate;break; } catch { /* Next installed browser. */ }
}
assert.ok(executable, "Installed browser");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run",
  "--remote-debugging-port=0", `--user-data-dir=${join(temporary, "profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let debugPort;
  for (let i = 0; i < 160 && !debugPort; i++) {
    try { debugPort = (await readFile(join(temporary, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await pause(); }
  }
  assert.ok(debugPort, "Isolated browser ready");
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve;socket.onerror = reject; });
  let sequence = 0;const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data), item = pending.get(message.id);
    if (!item) return;pending.delete(message.id);clearTimeout(item.timer);
    if (message.error) item.reject(Error(JSON.stringify(message.error)));else item.resolve(message.result); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id);reject(Error("CDP timeout: " + method)); }, 5000);
    pending.set(id, { resolve, reject, timer });socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => { const result = await cdp("Runtime.evaluate", { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));return result.result.value; };
  const until = async (expression, label) => {
    let ready;for (let i = 0; i < 100; i++) { ready = await evaluate(expression);if (ready) break;await pause(); }
    if (!ready) console.log(await evaluate("({errors:window.test?.errors,text:document.body.textContent.slice(0,1200)})"));
    check(ready, label);
  };
  await cdp("Network.enable");await cdp("Network.setBlockedURLs", { urls: ["https://*"] });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/patient/dashboard` });
  await until("!!document.querySelector('.pwa-week-row')", "Actual authorized synthetic Dashboard mounted");
  await evaluate("window.initialHeader=document.querySelector('.pwa-topbar');true");
  // Test scroll even on empty pages, without adding application content or changing data.
  await evaluate("const s=document.createElement('style');s.textContent='.pwa-content-inner{min-height:1800px}';document.head.append(s)");
  for (const width of [320, 360, 375, 390, 412, 768, 1024, 1366, 1920]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    let headerGeometry;
    for (const [label, route, selector] of [
      ["Medical Record", "medical-record", ".pwa-registration-history"],
      ["Appointments", "appointments", ".pwa-appointments-page"],
      ["Reminders", "reminders", ".pwa-reminders-page"],
      ["Dashboard", "dashboard", ".pwa-week-row"],
      ["Profile", "profile", ".pwa-profile-page"],
      ["Settings", "settings", ".pwa-settings-page"],
    ]) {
      await evaluate("window.scrollPatient(550)");
      check(await evaluate("document.querySelector('.pwa-main').scrollTop>=500"), `${width}px: normal section scrolling`);
      check(await evaluate("document.querySelector('.pwa-topbar').getBoundingClientRect().bottom<=0"), `${width}px: header scrolls completely out of view`);
      if (route === "profile" || route === "settings") await evaluate("window.scrollPatient(0)");
      if (route === "profile" || route === "settings") {
        await evaluate("document.querySelector('[aria-label=\"Open patient profile menu\"]').click()");
        await evaluate(`[...document.querySelectorAll('.pwa-profile-menu button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
      } else await evaluate(`document.querySelector('.pwa-nav button[aria-label="${label}"]').click()`);
      await until(`location.pathname==='/patient/${route}'&&!!document.querySelector(${JSON.stringify(selector)})`, `${width}px: original ${label} route and actual page`);
      const geometry = await evaluate("(()=>{const h=document.querySelector('.pwa-topbar').getBoundingClientRect(),b=document.querySelector('.pwa-notification-bell').getBoundingClientRect(),p=document.querySelector('.pwa-profile-pill').getBoundingClientRect();return {top:h.top,height:h.height,bell:b.top+b.height/2,profile:p.top+p.height/2,content:document.querySelector('.pwa-content').getBoundingClientRect().top,bottom:h.bottom};})()");
      headerGeometry ||= geometry;
      // Shared page headings wrap independently; header height must contain its contents.
      check(geometry.top === 0 && geometry.height > 0 && await evaluate("(()=>{const h=document.querySelector('.pwa-topbar').getBoundingClientRect();return [...document.querySelectorAll('.pwa-topbar-heading > *, .pwa-notification-bell, .pwa-profile-pill')].every(e=>{const r=e.getBoundingClientRect();return r.top>=h.top-1&&r.bottom<=h.bottom+1&&r.left>=h.left-1&&r.right<=h.right+1;});})()"),
        `${width}px: naturally sized header contains the heading and controls on ${label}`);
      if (["dashboard", "medical-record", "appointments", "reminders"].includes(route)) {
        const title = route === "dashboard" ? "Dashboard" : `My ${label}`;
        check(await evaluate(`document.querySelectorAll('h1').length===1&&document.querySelector('.pwa-topbar-heading h1')?.textContent===${JSON.stringify(title)}`),
          `${width}px: one original ${label} heading shares the topbar`);
      }
      check(Math.abs(geometry.bell-geometry.profile)<1 &&
        (["profile", "settings"].includes(route) || Math.abs(geometry.bell-headerGeometry.bell)<1),
        `${width}px: bell/profile alignment consistent on ${label}`);
      check(geometry.content>=geometry.bottom, `${width}px: page content follows header without overlap`);
      for (const offset of [40, 150]) {
        await evaluate(`window.scrollPatient(${offset})`);
        check(await evaluate(`(()=>{const h=document.querySelector('.pwa-topbar').getBoundingClientRect();return Math.abs(h.top+${offset})<1&&Math.abs(h.bottom-(${geometry.bottom}-${offset}))<1;})()`), `${width}px ${label}: header moves with the page at ${offset}px, without direction-based hiding`);
      }
      await evaluate("window.scrollPatient(0)");
      check(await evaluate("(()=>{const h=document.querySelector('.pwa-topbar').getBoundingClientRect();return h.top===0&&h.bottom>0&&!!document.elementFromPoint(h.right-20,h.top+20)?.closest('.pwa-topbar');})()"), `${width}px ${label}: scrolling to top restores the visible header`);
      if (!await evaluate("document.querySelector('.pwa-main').scrollWidth<=document.querySelector('.pwa-main').clientWidth+1")) console.log(await evaluate("(()=>{const c=document.querySelector('.pwa-main'),r=c.getBoundingClientRect();return {width:innerWidth,route:location.pathname,client:c.clientWidth,scroll:c.scrollWidth,box:[r.top,r.bottom],offenders:[...c.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>r.right+1).slice(0,10).map(e=>[e.className,e.parentElement?.outerHTML.slice(0,600),e.getBoundingClientRect().width,e.getBoundingClientRect().right])};})()"));
      check(await evaluate("(()=>{const c=document.querySelector('.pwa-main'),r=c.getBoundingClientRect(),n=document.querySelector('.pwa-sidebar').getBoundingClientRect();return r.bottom<=innerHeight+1&&r.height>100&&c.scrollWidth<=c.clientWidth+1&&(innerWidth>780||r.bottom<=n.top+1);})()"), `${width}px ${label}: shared header/page scroller ends above navigation without horizontal overflow`);
      await evaluate("window.scrollPatient(100000)");
      check(await evaluate("(()=>{const c=document.querySelector('.pwa-main'),r=c.getBoundingClientRect(),i=c.querySelector('.pwa-content-inner').getBoundingClientRect(),h=document.querySelector('.pwa-topbar').getBoundingClientRect(),n=document.querySelector('.pwa-sidebar').getBoundingClientRect();return Math.abs(c.scrollTop-(c.scrollHeight-c.clientHeight))<2&&i.bottom<=r.bottom+1&&window.scrollY===0&&document.querySelector('.pwa-content').scrollTop===0&&h.bottom<=0&&Math.abs(h.top+c.scrollTop)<1&&n.top>=0&&n.bottom<=innerHeight+1&&(innerWidth>780||Math.abs(n.bottom-innerHeight)<1);})()"), `${width}px ${label}: final content reachable; header gone, sidebar/bottom navigation stationary`);
      check(await evaluate("(()=>{const controls=[...document.querySelectorAll('.pwa-content-inner button,.pwa-content-inner input,.pwa-content-inner a')].filter(e=>e.getClientRects().length&&!e.disabled);window.lastPageControl=controls.at(-1);window.lastPageControl?.scrollIntoView({block:'end',inline:'nearest',behavior:'instant'});return !!window.lastPageControl;})()"), `${width}px ${label}: final page control can be brought into view`);
      check(await evaluate("(()=>{const e=window.lastPageControl,r=e.getBoundingClientRect(),m=document.querySelector('.pwa-main').getBoundingClientRect();return r.top>=m.top-1&&r.bottom<=m.bottom+1&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))&&window.scrollY===0;})()"), `${width}px ${label}: final control is visible, uncovered and reachable above bottom navigation`);
      await evaluate("window.scrollPatient(0)");
      check(await evaluate("(()=>{const b=document.querySelector('.pwa-nav button[aria-label=\"Reminders\"]'),r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===b;})()"), `${width}px ${label}: sidebar/bottom navigation remains visible and usable`);
      if (width === 375 && route === "reminders") {
        await evaluate("window.scrollPatient(450)");
        const scrollShot = await cdp("Page.captureScreenshot", { format: "png" });
        await writeFile(join(temporary, "mobile-reminders-scrolled.png"), Buffer.from(scrollShot.data, "base64"));
        await evaluate("window.scrollPatient(0)");
      }
      if (route === "appointments") check(await evaluate("document.querySelectorAll('.patient-book-appointment-button').length===1&&!!document.querySelector('.pwa-topbar-heading .pwa-ui-page-header .patient-book-appointment-button')"), "One Book Appointment action remains with its shared page heading");
      if (width === 1366 && route === "appointments") {
        await pause(300);
        const headerShot = await cdp("Page.captureScreenshot", { format: "png" });
        await writeFile(join(temporary, "desktop-appointments.png"), Buffer.from(headerShot.data, "base64"));
      }
      check(await evaluate("document.querySelector('.pwa-main').scrollTop===0&&document.querySelector('.pwa-main').scrollTop===0"), `${width}px: destination begins at top`);
      check(await evaluate("document.querySelector('.pwa-topbar')===window.initialHeader"), "Header remains mounted across navigation");
      check(await evaluate("document.documentElement.scrollWidth<=innerWidth"), `${width}px: no page horizontal overflow`);
      await evaluate("document.querySelector('[aria-label=\"Open patient profile menu\"]').click()");
      check(await evaluate("(()=>{const m=document.querySelector('.pwa-profile-menu'),r=m.getBoundingClientRect();return !!m&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<innerHeight-70;})()"), `${width}px: profile control and menu accessible`);
      await evaluate("document.querySelector('[aria-label=\"Close patient profile menu\"]').click()");
      if (route === "medical-record") {
        await until("document.querySelectorAll('.pwa-registration-history strong').length===8", "All eight registration fields loaded");
        check(await evaluate("!document.querySelector('.pwa-history-disclosure').open&&document.querySelectorAll('.pwa-history-summary dt').length===3"), `${width}px: compact summary defaults to collapsed history`);
        check(await evaluate("JSON.stringify([...document.querySelectorAll('.pwa-history-summary dd')].map(e=>e.textContent))===JSON.stringify(['2','1','1'])"), "G/P/L summary uses the same authorized history values");
        check(await evaluate("document.querySelector('.pwa-registration-history').getBoundingClientRect().height<320"), `${width}px: compact collapsed history card`);
        check(await evaluate("(()=>{const h=document.querySelector('.pwa-registration-history').getBoundingClientRect(),c=document.querySelector('.pwa-clinical-records').getBoundingClientRect();return Math.abs(h.left-c.left)<1&&Math.abs(h.right-c.right)<1&&c.top-h.bottom>=0&&c.top-h.bottom<=20})()"), `${width}px: history and clinical records share aligned bounds and compact spacing`);
        await evaluate("document.querySelector('.pwa-history-disclosure summary').focus()");
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await until("document.querySelector('.pwa-history-disclosure').open", "Keyboard opens all eight history fields");
        check(await evaluate("JSON.stringify([...document.querySelectorAll('.pwa-registration-history strong')].map(x=>x.textContent))===JSON.stringify(['2','1','1','0','0','1','February 24, 2030','December 1, 2030'])"), "Actual clinical mappings, zero values and dates preserved");
        check(await evaluate("[...document.querySelectorAll('.pwa-registration-history small,.pwa-registration-history strong')].every(e=>e.scrollWidth<=e.clientWidth+1)"), `${width}px: clinical labels and values do not truncate`);
        check(await evaluate(`getComputedStyle(document.querySelector('.pwa-registration-history .pwa-obstetric-grid')).gridTemplateColumns.split(' ').length===${width === 320 ? 1 : 2}`), `${width}px: readable responsive column count`);
        check(await evaluate("[...document.querySelectorAll('.pwa-registration-history strong')].every(e=>e.checkVisibility())"), `${width}px: all eight fields visible when expanded`);
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " ", unmodifiedText: " " });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        await until("!document.querySelector('.pwa-history-disclosure').open", "Space collapses history");
        check(await evaluate("[...document.querySelectorAll('.pwa-medical-record-tabs strong')].map(e=>e.textContent).join('|')==='Follow-Up Visit|Initial Visit'"), "Clinical visits remain in newest-first order");
        await evaluate("document.querySelector('.pwa-medical-record-tabs button').click()");
        await until("document.querySelector('.pwa-medical-card').textContent.includes('Synthetic recent diagnosis')", "Most recent visit details preserved");
        await evaluate("document.querySelectorAll('.pwa-medical-record-tabs button')[1].click()");
        await until("document.querySelector('.pwa-medical-card').textContent.includes('Synthetic earlier diagnosis')", "Visit selection still opens the selected encounter");
        await evaluate("document.querySelector('.pwa-history-disclosure summary').click();document.querySelector('.pwa-history-disclosure summary').click()");
        check(await evaluate("document.querySelector('.pwa-medical-card').textContent.includes('Synthetic earlier diagnosis')"), "History toggle preserves selected clinical encounter");
        await evaluate("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.pwa-medical-search input'),'Synthetic recent diagnosis');document.querySelector('.pwa-medical-search input').dispatchEvent(new Event('input',{bubbles:true}))");
        await until("!document.querySelector('.pwa-medical-record-tabs')&&document.querySelector('.pwa-medical-card')?.textContent.includes('Synthetic recent diagnosis')", "Clinical search filters records independently from history");
        await evaluate("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.pwa-medical-search input'),'no synthetic match');document.querySelector('.pwa-medical-search input').dispatchEvent(new Event('input',{bubbles:true}))");
        await until("document.querySelector('.pwa-medical-empty')?.textContent.includes('No matching medical record found')", "No-match search state retained");
        check(await evaluate("document.querySelector('.pwa-history-summary').textContent.includes('Living Children (L)')"), "Clinical search never filters Patient history");
        await evaluate("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.pwa-medical-search input'),'');document.querySelector('.pwa-medical-search input').dispatchEvent(new Event('input',{bubbles:true}))");
        await until("document.querySelectorAll('.pwa-medical-record-tabs button').length===2", "Clearing search restores visit navigation");
        check(await evaluate("document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.pwa-main').scrollWidth<=document.querySelector('.pwa-main').clientWidth+1"), `${width}px: populated records and history do not overflow`);
      }
      if (route === "reminders") {
        await until("window.test.notifications.length===1", "One legitimate due local presentation");
        check(await evaluate("document.body.textContent.includes('Sent')&&window.test.reminders[0].status==='sent'"), "Existing reminder status remains Sent");
        await evaluate("window.scrollPatient(200);document.querySelector('[aria-label=\"View all daily health tips\"]').click()");
        await until("!!document.querySelector('dialog[open]')&&getComputedStyle(document.querySelector('.pwa-main')).overflowY==='hidden'", "Shared Reminders preview locks the actual background scroller");
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await until("!document.querySelector('dialog[open]')&&getComputedStyle(document.querySelector('.pwa-main')).overflowY==='auto'", "Shared preview closes and unlocks");
        check(await evaluate("document.querySelector('.pwa-main').scrollTop===200"), "Standalone preview restores previous page scroll");
      }
    }
  }
  await evaluate("document.querySelector('.pwa-nav button[aria-label=\"Dashboard\"]').click()");
  await until("!!document.querySelector('.pwa-week-row')", "Return from actual Settings to Dashboard");
  check(await evaluate("window.test.notifications.length===1"), "Repeated navigation to Reminders cannot repeat the same local notification");
  await evaluate("window.scrollPatient(300);document.querySelector('.pwa-tip-actions button').click()");
  await until("!!document.querySelector('dialog[open]')", "Dashboard health-tip preview still opens");
  await until("getComputedStyle(document.querySelector('.pwa-main')).overflowY==='hidden'", "Native Dashboard preview locks the actual scroller");
  check(await evaluate("document.querySelector('.pwa-main').scrollTop===300&&location.pathname==='/patient/dashboard'"), "Same-section preview does not reset page scroll or route");
  const listPoint = await evaluate("(()=>{const r=document.querySelector('dialog [role=region]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
  await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...listPoint, deltaX: 0, deltaY: 350 });
  await until("document.querySelector('dialog [role=region]').scrollTop>0", "Modal tips scroll with real wheel input");
  check(await evaluate("document.querySelector('.pwa-main').scrollTop===300"), "Modal wheel scrolling leaves the underlying page stationary");
  await evaluate("history.back()");await until("!document.querySelector('dialog')", "Preview Back closes in place");
  check(await evaluate("document.querySelector('.pwa-main').scrollTop===300&&location.pathname==='/patient/dashboard'"), "Preview close preserves underlying scroll");
  await until("getComputedStyle(document.querySelector('.pwa-main')).overflowY==='auto'", "Dashboard close unlocks actual scroller");
  const contentPoint = await evaluate("(()=>{const r=document.querySelector('.pwa-main').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
  await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...contentPoint, deltaX: 0, deltaY: 200 });
  await until("document.querySelector('.pwa-main').scrollTop>300", "Normal page wheel scrolling resumes after modal close");
  await evaluate("document.querySelector('.pwa-nav button[aria-label=\"Medical Record\"]').click()");
  await until("!!document.querySelector('.pwa-registration-history strong')", "Records return normally");
  await evaluate("window.scrollPatient(450);history.back()");
  await until("location.pathname==='/patient/dashboard'&&document.querySelector('.pwa-main').scrollTop===0", "Cross-section history Back also starts at top");
  await evaluate("history.forward()");
  await until("location.pathname==='/patient/medical-record'&&document.querySelector('.pwa-main').scrollTop===0", "Cross-section Forward also resets the content region");
  await evaluate("history.back()");
  await until("location.pathname==='/patient/dashboard'&&document.querySelector('.pwa-main').scrollTop===0", "Return from Forward restores header and page to the top together");
  await evaluate("window.scrollPatient(400);window.test.beforeSame=window.test.reads.length;document.querySelector('.pwa-nav button[aria-label=\"Dashboard\"]').click()");
  await pause(100);
  check(await evaluate("document.querySelector('.pwa-main').scrollTop===400&&window.test.beforeSame===window.test.reads.length"), "Same-section navigation preserves scroll and does not repeat data loading");
  await evaluate("window.scrollPatient(450)");
  check(await evaluate("document.querySelector('.pwa-main').scrollTop===450&&document.querySelector('.pwa-content').scrollTop===0&&window.scrollY===0"), "Main owns page scrolling; content has no independent scroller");
  await evaluate("document.querySelector('.pwa-nav button[aria-label=\"Appointments\"]').click()");
  await until("location.pathname==='/patient/appointments'&&document.querySelector('.pwa-main').scrollTop===0&&document.querySelector('.pwa-main').scrollTop===0", "Section change resets internal owner as well as document");
  await evaluate("document.querySelector('.patient-book-appointment-button').click()");
  await until("location.pathname==='/patient/appointments/book'", "Book Appointment still opens its original route");
  await evaluate("history.back()");
  await until("location.pathname==='/patient/appointments'&&!!document.querySelector('.pwa-appointments-page')", "Return from booking preserves appointment page");
  await evaluate("document.querySelector('.pwa-notification-bell').click()");
  await until("!!document.querySelector('#patient-notification-panel')", "Existing notification dropdown still opens");
  await evaluate("document.querySelector('.pwa-notification-bell').click()");
  await until("!document.querySelector('#patient-notification-panel')", "Existing notification dropdown closes");
  check(await evaluate("window.test.reads.filter(x=>x==='get_current_patient_account_status').length===1"), "Section changes do not remount shell or repeat account authorization");
  check(await evaluate("window.test.errors.length===0"), "No browser runtime errors");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.querySelector('.pwa-nav button[aria-label=\"Medical Record\"]').click()");
  await until("!!document.querySelector('.pwa-registration-history strong')", "Final mobile record view");
  await pause(300);
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(join(temporary, "registration-history.png"), Buffer.from(shot.data, "base64"));
  // A visual viewport can shrink for the keyboard without resizing the layout viewport.
  await evaluate("Object.defineProperty(window.visualViewport,'height',{configurable:true,value:430});window.visualViewport.dispatchEvent(new Event('resize'))");
  check(await evaluate("(()=>{const h=document.querySelector('.pwa-topbar').getBoundingClientRect(),c=document.querySelector('.pwa-main').getBoundingClientRect(),n=document.querySelector('.pwa-sidebar').getBoundingClientRect();return h.top===0&&n.bottom===430&&c.top===h.top&&c.bottom<=n.top+1&&c.height>100;})()"), "Visual-only viewport shrink keeps header/page together above bottom navigation");
  await evaluate("const input=document.querySelector('.pwa-medical-search input');input.focus();input.scrollIntoView({block:'nearest'})");
  check(await evaluate("(()=>{const i=document.activeElement.getBoundingClientRect(),c=document.querySelector('.pwa-main').getBoundingClientRect();return i.top>=c.top-1&&i.bottom<=c.bottom+1&&window.scrollY===0;})()"), "Focused field remains reachable by naturally scrolling the main region in a shortened viewport");
  await evaluate("document.activeElement.blur();delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'))");
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 915, height: 412, deviceScaleFactor: 1, mobile: true });
  await evaluate("window.scrollPatient(0)");
  await until("(()=>{const h=document.querySelector('.pwa-topbar').getBoundingClientRect(),n=document.querySelector('.pwa-sidebar').getBoundingClientRect(),c=document.querySelector('.pwa-main');return matchMedia('(pointer: coarse)').matches&&h.top===0&&n.width===innerWidth&&Math.abs(n.bottom-innerHeight)<1&&c.getBoundingClientRect().bottom<=n.top+1&&c.scrollWidth<=c.clientWidth+1;})()", "Touch landscape retains the natural header at top and stationary bottom navigation beyond the narrow breakpoint");
  const touch = await evaluate("(()=>{const r=document.querySelector('.pwa-main').getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-30};})()");
  // The approved shared heading can be taller than one swipe; scroll sufficiently.
  for (let swipe = 0; swipe < 5; swipe++) {
    const before = await evaluate("document.querySelector('.pwa-main').scrollTop");
    await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...touch, id: 1 }] });
    for (const distance of [25, 50, 80, 110, 140]) {
      await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touch.x, y: touch.y-distance, id: 1 }] });await pause(30);
    }
    await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(`document.querySelector('.pwa-main').scrollTop>${before}`, "Actual touch gesture advances the main scroller");
    if (await evaluate("document.querySelector('.pwa-topbar').getBoundingClientRect().bottom<=0")) break;
  }
  await until("document.querySelector('.pwa-main').scrollTop>100&&document.querySelector('.pwa-topbar').getBoundingClientRect().bottom<=0&&window.scrollY===0", "Actual vertical touch swipe scrolls content and naturally carries the header off-screen");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await until("Math.abs(document.querySelector('.pwa-shell').getBoundingClientRect().height-innerHeight)<1&&Math.abs(document.querySelector('.pwa-sidebar').getBoundingClientRect().bottom-innerHeight)<1", "Returning to portrait restores viewport regions");
  await evaluate("window.test.obstetric={id:'synthetic-obstetric',patient_id:'synthetic-patient'};window.test.callbacks.findLast(x=>x.filter.table==='patient_obstetric_history').fn()");
  await until("document.querySelector('.pwa-registration-history strong')?.textContent==='Not provided'", "Missing clinical values retain Not provided meaning");
  check(await evaluate("[...document.querySelectorAll('.pwa-registration-history strong')].filter(x=>x.textContent==='Not provided').length===7&&document.querySelector('.pwa-registration-history').textContent.includes('December 1, 2030')"), "All missing values and existing Patient EDD fallback preserved");
  // Compare the actual two entry points using identical authorized synthetic libraries.
  const previewStart = assertions;
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
  for (const width of [320, 360, 375, 390, 412, 768, 1366]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const count of [0, 1, 4, 9, 30]) {
      await evaluate(`window.test.tipRows=Array.from({length:${count}},(_,i)=>({id:'comparison-'+i,title:'Synthetic tip '+i,
        content:i===${count - 1}&&i>0?'Long synthetic guidance. '.repeat(45):'Short synthetic guidance.',
        category:'Nutrition',display_schedule:i%2?'Weekly':'Daily',is_active:true}));
        window.test.tipRows.push({id:'foreign',title:'Foreign forbidden',content:'Foreign content',patient_id:'foreign-patient',is_active:true},
          {id:'inactive',title:'Inactive forbidden',content:'Inactive content',is_active:false});`);
      let dashboard;
      for (const [label, path, opener] of [
        ["Dashboard", "/patient/dashboard", ".pwa-tip-actions button"],
        ["Reminders", "/patient/reminders", '[aria-label="View all daily health tips"]'],
      ]) {
        await evaluate(`document.querySelector('.pwa-nav button[aria-label="${label}"]').click()`);
        await until(`location.pathname==='${path}'&&!!document.querySelector(${JSON.stringify(opener)})`, `${width}px ${count}: ${label} entry`);
        await evaluate("window.test.callbacks.filter(x=>x.filter.table==='health_tips').forEach(x=>x.fn())");
        await evaluate(`window.scrollPatient(300);window.previewOpener=document.querySelector(${JSON.stringify(opener)});window.previewOpener.focus({preventScroll:true});window.previewOpener.click()`);
        await until(`document.querySelectorAll('dialog[open] .patient-reminder-health-tip-item').length===${count}&&!!document.querySelector('dialog[open]')`, `${width}px ${count}: ${label} shared dialog opens`);
        await until("getComputedStyle(document.querySelector('.pwa-main')).overflowY==='hidden'", "Background page locked");
        const metrics = await evaluate(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),list=d.querySelector('[role=region]');
          const first=list.querySelector('article'),s=getComputedStyle(first),box=first.getBoundingClientRect();
          return {left:r.left,top:r.top,width:r.width,height:r.height,cardHeight:box.height,padding:s.padding,gap:s.gap,
            font:s.fontSize,lineHeight:s.lineHeight,title:d.querySelector('h2').textContent,count:d.querySelector('header p').textContent,
            ids:[...list.querySelectorAll('.patient-reminder-health-tip-item h3')].map(e=>e.textContent),
            schedules:[...list.querySelectorAll('.patient-reminder-health-tip-meta')].map(e=>e.textContent)};})()`);
        check(metrics.left >= 0 && metrics.left + metrics.width <= width + 1 && metrics.top >= 0 && metrics.top + metrics.height <= 800,
          `${label}: bounded desktop/mobile dialog`);
        check(Math.abs(metrics.left + metrics.width / 2 - width / 2) < 1 && Math.abs(metrics.top + metrics.height / 2 - 400) < 1,
          `${label}: centered compact dialog`);
        check(metrics.title === "All Health Tips" && metrics.count === `${count} active ${count === 1 ? "tip" : "tips"}`,
          `${label}: visible title and accurate authorized count`);
        check(await evaluate("(()=>{const d=document.querySelector('dialog');return d.contains(document.activeElement)&&document.body.style.overflow==='hidden'&&!d.textContent.includes('forbidden')})()"), `${label}: focus contained and unauthorized tips absent`);
        check(await evaluate("(()=>{const d=document.querySelector('dialog');return [...d.querySelectorAll('article')].every(e=>e.scrollWidth<=e.clientWidth+1)&&[...d.querySelectorAll('article p')].every(e=>e.scrollWidth<=e.clientWidth+1)})()"), `${label}: long descriptions wrap without clipping`);
        if (count) check(await evaluate("(()=>{const e=document.querySelector('dialog .patient-reminder-health-tip-item'),r=e.getBoundingClientRect(),s=getComputedStyle(e),bottom=Math.max(...[...e.children].map(c=>c.getBoundingClientRect().bottom));return Math.abs(r.bottom-bottom-parseFloat(s.paddingBottom)-parseFloat(s.borderBottomWidth))<2})()"), `${label}: short card height follows content without grid stretching`);
        if (count >= 9) {
          await evaluate("document.querySelector('dialog [role=region]').scrollTop=250");
          check(await evaluate("document.querySelector('dialog [role=region]').scrollTop>0&&document.querySelector('.pwa-main').scrollTop===300"), `${label}: list scrolls independently`);
        }
        if (label === "Dashboard") dashboard = metrics;
        else check(JSON.stringify(metrics) === JSON.stringify(dashboard), `${width}px ${count}: Dashboard/Reminders geometry, density, typography and content match exactly`);
        if (width === 375 && count === 4) {
          const shot = await cdp("Page.captureScreenshot", { format: "png" });
          await writeFile(join(temporary, `health-tips-${label.toLowerCase()}.png`), Buffer.from(shot.data, "base64"));
        }
        if (count === 4) await evaluate("history.back()");
        else if (count === 1) await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        else await evaluate("document.querySelector('dialog [aria-label=\"Close health tips preview\"]').click()");
        await until("!document.querySelector('dialog[open]')&&getComputedStyle(document.querySelector('.pwa-main')).overflowY==='auto'", `${label}: shared close/unlock`);
        check(await evaluate(`location.pathname==='${path}'&&document.querySelector('.pwa-main').scrollTop===300&&document.activeElement===window.previewOpener`), `${label}: close/Back/Escape restores route, scroll and opener focus`);
      }
    }
  }
  // Model the keyboard shrinking and panning the visual viewport without a layout resize.
  await evaluate("document.querySelector('[aria-label=\"View all daily health tips\"]').click()");
  await until("!!document.querySelector('dialog[open]')", "Reminders reopens for keyboard viewport check");
  await evaluate("Object.defineProperty(window.visualViewport,'height',{configurable:true,value:360});Object.defineProperty(window.visualViewport,'offsetTop',{configurable:true,value:40});window.visualViewport.dispatchEvent(new Event('resize'))");
  check(await evaluate("(()=>{const d=document.querySelector('dialog').getBoundingClientRect(),h=document.querySelector('dialog header').getBoundingClientRect();return d.top>=40&&d.bottom<=400&&Math.abs(d.top+d.height/2-220)<1&&h.bottom<=d.bottom})()"), "Visual viewport changes keep shared preview centered and title/close visible");
  await evaluate("delete window.visualViewport.height;delete window.visualViewport.offsetTop;window.visualViewport.dispatchEvent(new Event('resize'));document.querySelector('dialog button').click()");
  await until("!document.querySelector('dialog')", "Keyboard scenario closes normally");
  check(await evaluate("window.test.errors.length===0"), "No shared-preview runtime errors");
  console.log(`PASS: ${assertions - previewStart} shared Health Tips browser comparisons across seven widths and five library sizes.`);
  await evaluate("window.unmountFixture()");
  check(await evaluate("history.scrollRestoration===window.test.initialRestoration"), "Leaving Patient layout restores prior browser scroll-restoration policy");
  console.log(`PASS: ${assertions} Patient section assertions; nine widths, actual shell/pages including Profile/Settings, mocked reads and notification presentation. No live backend.`);
  console.log("Screenshot: " + join(temporary, "registration-history.png"));
} finally {
  socket?.close();browser.kill();await new Promise(resolve => server.close(resolve));
}
