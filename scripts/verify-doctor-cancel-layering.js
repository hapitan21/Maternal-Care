/* global process */
// Actual Doctor cancellation and inactivity portals; synthetic backend only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import postcss from "postcss";

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const mock = `
export const doctorId='22222222-2222-4222-8222-222222222222';
const patientId='11111111-1111-4111-8111-111111111111';
export const state={writes:[],defer:false,fail:false,pending:[],notifications:[]};
export const schedule={id:'synthetic-appointment',doctor_id:doctorId,patient_id:patientId,
 patient_name:'Synthetic Patient',doctor_name:'Synthetic Doctor',title:'Prenatal Checkup',
 description:'',start_time:'2026-10-09T00:30:00Z',end_time:'2026-10-09T01:00:00Z',status:'scheduled'};
const patient={id:patientId,full_name:'Synthetic Patient',patient_id:'PAT-001',status:'active'};
const result=data=>({data,error:null});
function query(table){let payload,id,single=false;return {
 select(){return this},order(){return this},limit(){return this},ilike(){return this},in(){return this},
 gte(){return this},lt(){return this},eq(key,value){if(key==='id')id=value;return this},
 maybeSingle(){single=true;return this},single(){single=true;return this},update(value){payload=value;return this},
 then(resolve,reject){
  const complete=()=>{if(payload&&state.fail)return {data:null,error:{message:'Synthetic cancellation failure'}};
   if(payload)Object.assign(schedule,payload);
   const rows=table==='schedule'?[schedule]:table==='patients'?[patient]:[];
   return result(single?rows.find(row=>!id||row.id===id):rows)};
  if(payload){state.writes.push({table,payload,id});if(state.defer)
   return new Promise(done=>state.pending.push(()=>done(complete()))).then(resolve,reject)}
  return Promise.resolve(complete()).then(resolve,reject);
 }};
}
function rpc(name){
 if(name==='get_doctor_patient_directory')return {select(){return this},order(){return this},
  then(resolve,reject){return Promise.resolve(result([patient])).then(resolve,reject)}};
 if(name==='get_operational_appointment_policy')return Promise.resolve(result({timezone:'Asia/Manila',
  clinic_opening_time:'08:00',clinic_closing_time:'17:00',default_appointment_duration_minutes:30}));
 throw new Error('Unexpected offline RPC: '+name);
}
export const supabase={from:query,rpc,channel(){return {on(){return this},subscribe(){return this}}},
 removeChannel(){},auth:{async getUser(){return result({user:{id:doctorId}})}}};
export async function notify(args){state.notifications.push(args);return {ok:true}}
`;

const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {_api} from '@iconify/react';
import '${root}/src/index.css';
import '${root}/src/styles/doctor-dashboard.css';
import {DoctorAppointmentsContent} from '${root}/src/pages/doctor/Doctor_Appointments.jsx';
import InactivityWarningDialog from '${root}/src/components/auth/InactivityWarningDialog.jsx';
import {state,schedule,doctorId} from 'cancel-layering-mock';
_api.setFetch(async()=>({status:404}));
const NativeDate=Date;
Date=class extends NativeDate {constructor(...args){super(...(args.length?args:['2026-10-07T02:00:00Z']))}
 static now(){return NativeDate.parse('2026-10-07T02:00:00Z')}};
const harness={backgroundClicks:0,stayClicks:0,state,schedule};
window.cancelLayering=harness;
function Shell(){const [warning,setWarning]=useState(false);harness.setWarning=setWarning;
 return <MemoryRouter initialEntries={['/doctor/appointments']}><div className='doctor-dashboard'>
 <aside className='doctor-sidebar'><nav className='doctor-nav'><button id='test-sidebar'
 className='doctor-nav-link' onClick={()=>harness.backgroundClicks++}>☰<span>Dashboard</span></button></nav></aside>
 <main className='doctor-main'><div className='doctor-global-profile-slot'>
 <div className='doctor-shell-header-controls'><div className='doctor-profile-wrapper'>
 <button id='test-profile' className='doctor-profile-card' onClick={()=>harness.backgroundClicks++}>
 <span className='doctor-profile-info'><strong>Synthetic Doctor</strong><span>Doctor</span></span></button>
 <div className='doctor-profile-dropdown'><div className='doctor-dropdown-menu'>
 <button id='test-profile-settings' onClick={()=>harness.backgroundClicks++}>Settings</button>
 </div></div></div></div></div><div className='doctor-content'>
 <DoctorAppointmentsContent embedded doctorIdentity={{authUser:{id:doctorId},doctorDisplayName:'Synthetic Doctor',loading:false}}
 headerAction={<span className='doctor-global-profile-placeholder' aria-hidden='true'/>}/>
 </div></main></div>{warning?<InactivityWarningDialog secondsRemaining={60}
 onStayLoggedIn={()=>{harness.stayClicks++;setWarning(false)}}/>:null}</MemoryRouter>;
}
createRoot(document.getElementById('root')).render(<Shell/>);
`;

const result = await build({ root, configFile: false, logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-doctor-cancel-layering", enforce: "pre",
    resolveId(id) {
      if (id.endsWith("cancel-layering-test.jsx")) return "\0cancel-layering-test.jsx";
      if (id === "cancel-layering-mock" || /\/supabaseClient(?:\.js)?$/.test(id)) return "\0cancel-layering-mock.js";
      if (/\/automaticAppointmentNotification(?:\.js)?$/.test(id)) return "\0cancel-layering-notify.js";
      if (/\/(AppointmentVisitForm|SendPatientNotificationAction)(?:\.jsx)?$/.test(id)) return "\0cancel-layering-unused.jsx";
    },
    load(id) {
      if (id === "\0cancel-layering-test.jsx") return fixture;
      if (id === "\0cancel-layering-mock.js") return mock;
      if (id === "\0cancel-layering-notify.js") return "export {notify as sendAutomaticAppointmentNotification} from 'cancel-layering-mock'";
      if (id === "\0cancel-layering-unused.jsx") return "export default function UnusedFixture(){return null}";
    },
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/Doctor_Appointments.jsx")) return;
      const marker = "  if (visitRoute) {";
      assert.ok(source.includes(marker), "Expose actual handlers only in the offline build");
      return source.replace(marker, "  window.cancelLayering.api={setCancelConfirmationSchedule,setCancelReason,closeCancelConfirmation,confirmCancelAppointment};\n" + marker);
    },
  }, react()],
  build: { write: false, minify: false, lib: { entry: "cancel-layering-test.jsx", formats: ["es"] } },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
const code = outputs.find(output => output.type === "chunk").code.replaceAll("</script", "<\\/script");
const css = postcss.parse(outputs.filter(output => output.type === "asset" && output.fileName.endsWith(".css"))
  .map(output => output.source).join("\n"));
css.walkAtRules("import", rule => rule.remove());
const baselineCss = css.clone();
let removed = 0;
baselineCss.walkRules(rule => {
  if (rule.selector === ".doctor-appointment-confirm-overlay:has(> .doctor-cancel-appointment-card)") {
    rule.remove(); removed++;
  }
});
assert.equal(removed, 1, "The correction targets only the Doctor cancellation portal");
const temporary = await mkdtemp(join(tmpdir(), "maternal-doctor-cancel-layering-"));
const html = join(temporary, "fixture.html"), baseline = join(temporary, "baseline.html");
const documentHtml = styles => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style><div id="root"></div><script type="module">${code}</script>`;
await writeFile(html, documentHtml(css));
await writeFile(baseline, documentHtml(baselineCss));
const candidates = process.env.HEADLESS_BROWSER ? [process.env.HEADLESS_BROWSER] : [
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome",
];
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch { /* Try next installation. */ } }
assert.ok(executable, "Set HEADLESS_BROWSER to an installed Chrome/Chromium executable");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions",
  "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
  `--user-data-dir=${join(temporary, "browser-profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket, cdp, assertions = 0;
const check = (condition, label) => { assert.ok(condition, label); assertions++; };
try {
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(temporary, "browser-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await pause(); }
  }
  assert.ok(port, "Offline Chrome starts");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error("Browser command timeout: " + method)); }, 5000).unref();
  });
  const evaluate = async expression => {
    const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await pause(); }
    throw new Error("Fixture wait timed out: " + expression);
  };
  const open = async () => {
    await evaluate("window.cancelLayering.api.setCancelConfirmationSchedule({...window.cancelLayering.schedule,status:'scheduled'})");
    await until("!!document.querySelector('.doctor-cancel-appointment-card')");
    await evaluate("Promise.allSettled(document.querySelector('.doctor-cancel-appointment-card').getAnimations().map(a=>a.finished))");
  };
  const physicalClick = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector('${selector}');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: pathToFileURL(baseline).href });
  await until("!!window.cancelLayering?.api"); await open();
  check(await evaluate("Number(getComputedStyle(document.querySelector('.doctor-appointment-confirm-overlay')).zIndex)<Number(getComputedStyle(document.querySelector('.doctor-global-profile-slot')).zIndex)"),
    "Removing only R1 reproduces the lower cancellation layer (R5 independently makes the background inert)");

  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1024, 768], [1171, 980], [1260, 900], [1440, 900]]) {
    const before = assertions;
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: pathToFileURL(html).href });
    await until("!!window.cancelLayering?.api"); await open();
    check(await evaluate("document.compatMode==='CSS1Compat'"), "Standards-mode rendering");
    check(await evaluate("(()=>{const d=document.querySelector('.doctor-appointment-confirm-overlay'),p=document.querySelector('.doctor-global-profile-slot'),r=d.getBoundingClientRect(),c=d.firstElementChild.getBoundingClientRect();return Number(getComputedStyle(d).zIndex)>Number(getComputedStyle(p).zIndex)&&r.x===0&&r.y===0&&r.right>=innerWidth&&r.bottom>=innerHeight&&c.x>=0&&c.right<=innerWidth&&c.y>=0&&c.bottom<=innerHeight})()"),
      "Cancellation backdrop covers the viewport and dialog fits above shell controls");
    const targets = await evaluate("['#test-profile','#test-profile-settings','#test-sidebar','.doctor-appointments-add'].map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;const visible=r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight;const hit=visible?document.elementFromPoint(x,y):null;return{selector,visible,x,y,blocked:!!hit?.closest('.doctor-appointment-confirm-overlay'),backdrop:hit?.classList.contains('doctor-appointment-confirm-overlay')}})");
    for (const target of targets) {
      if (!target.visible) continue;
      check(target.blocked, width + "px blocks " + target.selector);
      if (target.backdrop) {
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: target.x, y: target.y });
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: target.x, y: target.y });
        await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: target.x, y: target.y }] });
        await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
    }
    check(await evaluate("window.cancelLayering.backgroundClicks===0 && !!document.querySelector('.doctor-cancel-appointment-card')"), "Backdrop mouse/touch clicks do not activate background or dismiss dialog");
    await physicalClick(".doctor-cancel-confirm-button");
    await until("!!document.querySelector('.doctor-appointment-modal-error')");
    check(await evaluate("window.cancelLayering.state.writes.length===0"), "Required reason validation still blocks cancellation");
    await physicalClick(".doctor-cancel-keep-button");
    await until("!document.querySelector('.doctor-cancel-appointment-card')");
    check(await evaluate("window.cancelLayering.state.writes.length===0"), "Keep Appointment remains clickable without mutation");

    await open(); await evaluate("window.cancelLayering.setWarning(true)");
    await until("!!document.querySelector('.inactivity-backdrop')");
    check(await evaluate("(()=>{const w=document.querySelector('.inactivity-backdrop'),d=document.querySelector('.doctor-appointment-confirm-overlay'),b=w.querySelector('button'),r=b.getBoundingClientRect();return Number(getComputedStyle(w).zIndex)>Number(getComputedStyle(d).zIndex)&&!!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.inactivity-backdrop')})()"), "Real inactivity warning portal has higher priority and clickable Stay Logged In");
    await physicalClick(".inactivity-dialog button");
    await until("!document.querySelector('.inactivity-backdrop')");
    check(await evaluate("window.cancelLayering.stayClicks===1 && !!document.querySelector('.doctor-cancel-appointment-card')"), "Stay Logged In preserves the underlying cancellation dialog");

    await evaluate("window.cancelLayering.state.defer=true;window.cancelLayering.api.setCancelReason('Synthetic reason')"); await pause();
    await physicalClick(".doctor-cancel-confirm-button");
    await until("window.cancelLayering.state.pending.length===1");
    check(await evaluate("[...document.querySelectorAll('.doctor-cancel-appointment-card button, .doctor-cancel-appointment-card textarea')].every(e=>e.disabled)"), "All existing close, reschedule, reason, Keep and Confirm busy guards remain enabled");
    await evaluate("window.cancelLayering.api.closeCancelConfirmation();window.cancelLayering.api.confirmCancelAppointment()");
    check(await evaluate("!!document.querySelector('.doctor-cancel-appointment-card') && window.cancelLayering.state.writes.length===1"), "Guarded close and duplicate Confirm cannot bypass pending cancellation");
    await evaluate("window.cancelLayering.state.pending.shift()()");
    await until("!document.querySelector('.doctor-cancel-appointment-card')");
    check(await evaluate("window.cancelLayering.state.writes.length===1 && window.cancelLayering.schedule.status==='cancelled'"), "Confirm executes the existing cancellation exactly once");

    await evaluate("window.cancelLayering.state.defer=false;window.cancelLayering.state.fail=true"); await open();
    await evaluate("window.cancelLayering.api.setCancelReason('Synthetic retry')"); await pause();
    await physicalClick(".doctor-cancel-confirm-button");
    await until("!!document.querySelector('.doctor-appointment-modal-error')");
    check(await evaluate("!!document.querySelector('.doctor-cancel-appointment-card') && !document.querySelector('.doctor-cancel-confirm-button').disabled"), "Returned mutation error leaves existing retryable dialog enabled");
    await physicalClick(".doctor-appointment-modal-close");
    await until("!document.querySelector('.doctor-cancel-appointment-card')");
    check(await evaluate("window.cancelLayering.state.writes.length===2"), "Close after failure performs no extra mutation");
    check(await evaluate("(()=>{const d=document.createElement('div');d.className='doctor-appointment-confirm-overlay';d.innerHTML='<section class=\"doctor-appointment-reschedule-card\"></section>';document.body.append(d);const z=getComputedStyle(d).zIndex;d.remove();return z==='5200'})()"), "Other confirmation-overlay consumers retain their prior layer");
    console.log(`${width}x${height}: ${assertions - before} assertions passed`);
  }
  console.log(`Doctor cancel layering: ${assertions} browser assertions passed. Actual portals/handlers; backend and notifications mocked; HTTP(S) blocked.`);
  console.log(`Temporary fixtures: ${temporary}`);
} finally {
  if (cdp) await cdp("Browser.close").catch(() => browser.kill()); else browser.kill();
  socket?.close();
}
