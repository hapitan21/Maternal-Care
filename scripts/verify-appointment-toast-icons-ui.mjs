// Actual toast/panel components and CSS; synthetic content, no backend or providers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import postcss from "postcss";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const read = p => readFile(join(root, p), "utf8");
const staff = await read("src/pages/staff/Staff_Appointments.jsx");
const start = staff.indexOf("{successMessage ? createPortal("), end = staff.indexOf(") : null}", start) + 9;
assert(start > 0 && end > start);
const successMarkup = staff.slice(start, end);
const handlers = staff.slice(staff.indexOf("  const clearSuccessTimer = useCallback("), staff.indexOf('  useClinicalSaveFeedback("staff"'));
assert(handlers.includes("5000") && handlers.includes("dismissSuccessMessage"));
const css = postcss.parse((await Promise.all(["staff-dashboard.css", "doctor-appointments.css", "staff-appointments.css", "appointment-ui-system.css", "patient-notifications.css"]
  .map(p => read("src/styles/" + p)))).join("\n"));
css.walkAtRules("import", rule => rule.remove());
const fixture = `
import React,{useState,useRef,useEffect,useCallback} from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
import{BrowserRouter}from'react-router-dom';import{Icon}from'@iconify/react';
import{StaffBookingRequestToast,StaffBookingRequestBadge}from'${root}/src/components/staff/StaffBookingRequestNotifications.jsx';
import{useAppointmentToastPlacement}from'${root}/src/hooks/useAppointmentToastPlacement.js';
import Panel from'${root}/src/components/patient/PatientNotificationPanel.jsx';
window.test={errors:[],timers:new Map(),dismissed:0,clicked:0};window.addEventListener('error',e=>window.test.errors.push(e.message));
const nativeSet=window.setTimeout.bind(window),nativeClear=window.clearTimeout.bind(window);let nextTimer=-1;
window.setTimeout=(fn,delay,...args)=>{if(delay===5000){const id=nextTimer--;window.test.timers.set(id,fn);return id;}return nativeSet(fn,delay,...args);};
window.clearTimeout=id=>{if(id<0)window.test.timers.delete(id);else nativeClear(id);};
window.expireToasts=()=>{for(const[id,fn]of[...window.test.timers]){window.test.timers.delete(id);fn();}};
const variants=['appointment_cancelled','appointment_canceled','Appointment Cancelled','Appointment Canceled','appointment_created','appointment_rescheduled','medication_reminder','general'];
const rows=variants.map((type,i)=>({id:'synthetic-'+i,type,title:type,message:'Synthetic notification',created_at:new Date().toISOString(),priority:'important',read_at:null}));
function App(){const[toast,setToast]=useState(null),[successMessage,setSuccessMessage]=useState(''),[successTitle,setSuccessTitle]=useState(''),
 [statusMessage,setStatusMessage]=useState(''),[statusMessageVersion,setStatusMessageVersion]=useState(0),[mode,setMode]=useState('staff'),[modal,setModal]=useState(false);
 const successTimerRef=useRef(null);const successToastRef=useAppointmentToastPlacement(successMessage,statusMessageVersion,'.staff-appointments-page',false);
 ${handlers}
 const dismiss=useCallback(()=>{window.test.dismissed++;setToast(null);},[]);
 window.showToast=type=>{setMode('staff');if(type==='new')setToast({id:crypto.randomUUID()});else showSuccessMessage(type==='approved'?'Appointment request approved and moved to Pending appointments.':'Appointment request declined. No appointment was created.');};
 window.showPanel=()=>{setToast(null);dismissSuccessMessage();setMode('patient');};window.showModal=setModal;
 return <><main className="staff-appointments-page appointment-workspace" style={{padding:16}} hidden={mode!=='staff'}>
 <header className="appointment-ui-header"><h1>Appointments <StaffBookingRequestBadge count={3}/></h1></header>
 <div className="appointment-ui-toolbar"><input data-search aria-label="Search requests"/><button onClick={()=>window.test.clicked++}>Search</button></div>
 <div data-calendar style={{height:180,background:'#fff0f5'}}>Synthetic calendar</div>
 <div data-list><table className="appointment-ui-table-card"><tbody><tr><td>Synthetic request</td><td><button>View</button><button>Approve</button><button>Decline</button></td></tr></tbody></table></div>
 </main><StaffBookingRequestToast toast={toast} onDismiss={dismiss}/>${successMarkup}
 {mode==='patient'?<div className="patient-fixture"><Panel notifications={rows} unreadCount={8} loading={false} updating={false} online={true} onClose={()=>{}} onSelect={()=>{}} onMarkAllAsRead={()=>{}} onOpenSettings={()=>{}}/></div>:null}
 {modal?createPortal(<div data-modal style={{position:'fixed',inset:0,zIndex:5000,background:'white'}} role="dialog">Synthetic modal</div>,document.body):null}
 </>;
}createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`;
const bundle = await build({ root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-toast-icons", enforce: "pre", resolveId(id) {
    if (id.endsWith("toast-icons-fixture.jsx")) return "\0fixture.jsx";
    if (id === "@iconify/react") return "\0icon";
  }, load(id) {
    if (id === "\0fixture.jsx") return fixture;
    // Other icon mappings retain their identifiers; CalendarX uses real bundled SVG.
    if (id === "\0icon") return `import React from'react';export const Icon=({icon,...p})=>React.createElement('svg',{'data-icon':icon,width:'1em',height:'1em',...p},React.createElement('circle',{cx:8,cy:8,r:4}));`;
  } }], build: { write: false, minify: false, lib: { entry: "toast-icons-fixture.jsx", formats: ["es"] } } });
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(x => x.output);
const code = outputs.find(x => x.type === "chunk").code.replaceAll("</script", "<\\/script");
const temporary = await mkdtemp(join(tmpdir(), "maternal-toast-icons-")), html = join(temporary, "fixture.html");
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
body{margin:0;font-family:Arial;--pwa-pink:#df467c}*{box-sizing:border-box}.patient-fixture{padding:12px}.patient-fixture .pwa-notification-panel{position:relative;inset:auto;width:min(430px,100%);max-height:90vh}
</style><div id="root"></div><script type="module">${code}</script>`);
let executable;
for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
  try { await access(candidate); executable = candidate; break; } catch { /* Next browser. */ }
}
assert(executable, "Installed Chrome required");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${join(temporary, "profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
let socket, assertions = 0;
const check = (value, label) => { assert.ok(value, label); assertions++; };
try {
  let port;
  for (let i = 0; i < 160 && !port; i++) { try { port = (await readFile(join(temporary, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await pause(); } }
  assert(port);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(Error(JSON.stringify(m.error))); else p.resolve(m.result); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method)); }, 5000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await cdp("Runtime.evaluate", { expression, returnByValue: true }); assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await pause(); } throw Error("Browser condition: " + expression); };
  await cdp("Network.enable"); await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Page.navigate", { url: pathToFileURL(html).href }); await until("typeof window.showToast==='function'");
  const coordinates = "JSON.stringify([...document.querySelectorAll('.appointment-ui-header,.appointment-ui-toolbar,[data-calendar],[data-list],table')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height,e.style.marginBottom]}))";
  for (const width of [320, 360, 390, 768, 1366]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
    for (const type of ["new", "approved", "declined"]) {
      const before = await evaluate(coordinates);
      await evaluate(`window.showToast('${type}')`); await until("!!document.querySelector('.staff-booking-request-toast,.staff-appointment-feedback-toast')"); await pause();
      check(await evaluate(coordinates) === before, `${width}/${type}: header/search/calendar/list/table coordinates unchanged`);
      check(await evaluate("(()=>{const t=document.querySelector('.staff-booking-request-toast,.staff-appointment-feedback-toast'),r=t.getBoundingClientRect();return t.parentElement===document.body&&getComputedStyle(t).position==='fixed'&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&r.width<=320&&getComputedStyle(t).pointerEvents==='none'})()"), `${width}/${type}: compact floating portal fits viewport and passes through interactions`);
      check(await evaluate("!document.querySelector('.staff-booking-request-toast__content button')&&document.querySelectorAll('table button').length===3&&!!document.querySelector('.staff-booking-request-badge')"), "Only temporary CTA removed; table actions and badge retained");
      check(await evaluate("!!document.querySelector('[role=status][aria-live=polite]')"), "Polite announcement retained");
      await evaluate("document.querySelector('.staff-booking-request-toast__close,.appointment-success-toast__close').focus();document.activeElement.click()"); await pause();
      check(await evaluate("!document.querySelector('.staff-booking-request-toast,.staff-appointment-feedback-toast')") && await evaluate(coordinates) === before, "Manual dismissal restores no reserved space");
      await evaluate(`window.showToast('${type}')`); await until("window.test.timers.size>0");
      await evaluate("window.expireToasts()"); await pause();
      check(await evaluate("!document.querySelector('.staff-booking-request-toast,.staff-appointment-feedback-toast')") && await evaluate(coordinates) === before, "Existing five-second callbacks dismiss without layout shift");
    }
    await evaluate("window.showToast('new');window.showToast('approved')"); await until("!!document.querySelector('.staff-appointment-feedback-toast')");
    check(await evaluate("getComputedStyle(document.querySelector('.staff-booking-request-toast')).visibility==='hidden'"), "Approval feedback takes precedence without overlapping incoming toast");
    await evaluate("window.showModal(true)"); await pause();
    check(await evaluate("document.elementFromPoint(innerWidth/2,120).closest('[data-modal]')!==null"), "Modal remains above toast");
    await evaluate("window.showModal(false);window.expireToasts();window.showPanel()"); await until("!!document.querySelector('.pwa-notification-panel')");
    check(await evaluate("[...document.querySelectorAll('.pwa-notification-item')].slice(0,4).every(e=>{const s=e.querySelector('.pwa-notification-icon svg');return s?.classList.contains('lucide-calendar-x')&&s.querySelectorAll('path,line,rect').length>=3&&getComputedStyle(s).width==='21px'&&getComputedStyle(s).color==='rgb(223, 70, 124)'})"), `${width}: cancellation aliases render real pink calendar-X SVG offline at existing size`);
    check(await evaluate("[...document.querySelectorAll('.pwa-notification-item')].slice(4).map(e=>e.querySelector('.pwa-notification-icon svg').getAttribute('data-icon')).join(',')==='solar:calendar-add-bold,solar:calendar-mark-bold,solar:pill-bold,solar:bell-bold'"), "Other icon mappings unchanged");
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    if ([390, 1366].includes(width)) await writeFile(join(temporary, `cancelled-${width}.png`), Buffer.from(shot.data, "base64"));
    await evaluate("window.showToast('new')"); await until("window.test.timers.size>0");
    await evaluate("window.expireToasts()"); await pause();
  }
  check(await evaluate("window.test.errors.length===0"), "No browser runtime errors");
  console.log(`PASS: ${assertions} actual-browser assertions across five widths; real toast markup/handlers, fixed portals, dismissal, stable coordinates and bundled cancellation icons. No live services.`);
  console.log("Screenshots: " + temporary);
} finally { socket?.close(); browser.kill(); }
