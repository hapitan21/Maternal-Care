// Offline actual Staff request-details component/CSS; no Supabase imports or mutations.
// Decorative Iconify icons use local stand-ins; approval uses the installed Check icon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transformWithOxc } from "vite";
import postcss from "postcss";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const source = await readFile(new URL("../src/pages/staff/Staff_Appointments.jsx", import.meta.url), "utf8");
const start = source.indexOf("function StaffAppointmentRequestDetails(");
const end = source.indexOf("function StaffAppointmentsContent(", start);
assert.ok(start >= 0 && end > start, "Actual details component located");
const styles = postcss.parse((await Promise.all(["doctor-appointments.css", "appointment-ui-system.css", "staff-appointments.css", "send-patient-notification.css"]
  .map(path => readFile(new URL(`../src/styles/${path}`, import.meta.url), "utf8")))).join("\n"));
styles.walkAtRules("import", rule => rule.remove());
const css = styles.toString();
const fixture = `
import React,{useEffect,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {Check,UserRound,ChevronDown,ChevronRight,Clock,Calendar,Phone,Mail,Info,TriangleAlert,CircleCheck} from 'lucide-react';
import SendPatientNotificationAction from '${root}/src/components/notifications/SendPatientNotificationAction.jsx';
import {getAppointmentTypeLabel} from '${root}/src/lib/appointmentTypes.js';
const icons={'solar:alt-arrow-down-linear':ChevronDown,'solar:alt-arrow-right-linear':ChevronRight,
'solar:clock-circle-linear':Clock,'solar:calendar-linear':Calendar,'solar:phone-linear':Phone,
'solar:letter-linear':Mail,'solar:info-circle-linear':Info,'solar:danger-triangle-linear':TriangleAlert,'solar:check-circle-bold':CircleCheck};
function Icon({icon,...props}){const Symbol=icons[icon]||UserRound;return <Symbol size="1em" {...props}/>}
function ProfileAvatarContent({fallback}){return fallback}
const formatRequestDate=()=> 'Oct 20, 2026',formatAppointmentTime=()=> '8:00 AM',getRequestCategoryIcon=()=> 'solar:calendar-linear';
const getRequestId=request=>String(request.id);
${source.slice(start,end)}
window.staffDetailsUi={errors:[],events:[]};window.addEventListener('error',event=>window.staffDetailsUi.errors.push(event.message));
const request={id:123,patient_id:'11111111-1111-4111-8111-111111111111',patient_name:'Synthetic Patient',
title:'Prenatal Check-up',created_at:'2026-10-17T00:00:00Z',start_time:'2026-10-20T00:00:00Z',status:'pending'};
const patient={patient_id:'SYNTHETIC-ONLY',age:25,address:'Synthetic address',contact_number:'Not provided',email:'synthetic@example.test'};
const doctors=Array.from({length:10},(_,i)=>({id:'synthetic-doctor-'+i,name:i===9?'Dr. Synthetic Doctor With A Longer Display Name':'Dr. Synthetic '+i}));
function App(){const[selected,setSelected]=useState(doctors[0].id),[updating,setUpdating]=useState(false);
window.staffDetailsUi.updating=value=>flushSync(()=>setUpdating(value));return <main className="staff-appointments-page doctor-request-details-shell appointment-workspace appointment-workspace--staff">
<StaffAppointmentRequestDetails request={request} patient={patient} doctors={doctors} selectedDoctorId={selected}
onDoctorChange={value=>{window.staffDetailsUi.events.push(['select',value]);setSelected(value)}} isUpdating={updating}
onBack={()=>window.staffDetailsUi.events.push(['back'])} onApprove={value=>window.staffDetailsUi.events.push(['approve',value.id])}
onDecline={value=>window.staffDetailsUi.events.push(['decline',value.id])}/></main>}
createRoot(document.getElementById('root')).render(<App/>);`;
const compiled = (await transformWithOxc(fixture, "staff-details-fixture.jsx", { jsx: { runtime: "automatic" } })).code;
const bundle = await build({ root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-staff-request-details", enforce: "pre",
    resolveId(id) {
      if (id.endsWith("staff-details-fixture.js")) return "\0staff-details-fixture.js";
      if (/\/SendPatientNotificationModal(?:\.jsx)?$/.test(id)) return "\0offline-notification-modal.jsx";
      if (/\/supabaseClient(?:\.js)?$/.test(id)) throw Error("Real Supabase must not enter UI fixture");
    },
    load(id) {
      if (id === "\0staff-details-fixture.js") return compiled;
      if (id === "\0offline-notification-modal.jsx") return `import {createElement} from 'react';export default function Modal({onClose}){return createElement('div',{role:'dialog'},createElement('button',{onClick:onClose},'Close offline message preview'));}`;
    },
  }], build: { write: false, minify: false, lib: { entry: "staff-details-fixture.js", formats: ["es"] } },
});
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output);
const code = outputs.find(entry => entry.type === "chunk").code.replaceAll("</script", "<\\/script");
const temporary = await mkdtemp(join(tmpdir(), "maternal-staff-request-ui-")), html = join(temporary, "fixture.html");
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font-family:Arial,sans-serif;background:#f8f9fc}main{max-width:1150px;margin:auto}${css}
</style><div id="root"></div><script type="module">${code}</script>`);
let executable;
for (const path of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
  try { await access(path); executable = path; break; } catch { /* Next installed browser. */ }
}
assert.ok(executable, "Installed Chrome required");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(temporary, "browser-profile")}`, "about:blank"],
{ windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
let socket, assertions = 0, scenarios = 0;
const check = (value, label) => { assert.ok(value, label); assertions++; };
try {
  let port;
  for (let i = 0; i < 160 && !port; i++) { try { port = (await readFile(join(temporary, "browser-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await pause(); } }
  assert.ok(port, "Isolated browser started");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let sequence = 0;
  socket.onmessage = event => { const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return; pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result); };
  socket.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error("Offline browser connection closed")); } pending.clear(); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(Error(`Browser timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await cdp("Runtime.evaluate", { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const click = async selector => { const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }); await pause(); };
  const key = async (key, code, virtual) => { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual }); await pause(); };
  await cdp("Network.enable"); await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Page.navigate", { url: pathToFileURL(html).href });
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (let i = 0; i < 160; i++) { if (await evaluate("!!document.querySelector('.staff-request-doctor-trigger')")) break; await pause(); }
  for (const width of [320, 375, 480, 768, 1024, 1366, 1920]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.scrollTo(0,0)");
    const metrics = await evaluate(`(()=>{const b=document.querySelector('.staff-request-doctor-trigger'),r=b.getBoundingClientRect(),icons=b.querySelectorAll('svg'),a=icons[0].getBoundingClientRect(),z=icons[1].getBoundingClientRect(),text=b.querySelector('span').getBoundingClientRect(),label=document.querySelector('.staff-request-doctor-row dt').getBoundingClientRect(),approve=document.querySelector('.doctor-request-approve-button'),icon=approve.querySelector('svg'),i=icon.getBoundingClientRect(),button=approve.getBoundingClientRect();return {left:a.left-r.left,right:r.right-z.right,gap:text.left-a.right,aligned:Math.abs(a.y+a.height/2-z.y-z.height/2)<1,
      width:r.width,height:r.height,labelGap:r.top>=label.bottom?r.top-label.bottom:r.left-label.right,overflow:document.documentElement.scrollWidth>innerWidth,
      overflowElements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right})),
      root:(()=>{const e=document.querySelector('main'),s=getComputedStyle(e),r=e.getBoundingClientRect();return{left:r.left,width:r.width,cssWidth:s.width,box:s.boxSizing,padding:s.padding,margin:s.margin,body:document.body.clientWidth,document:document.documentElement.clientWidth}})(),
      marks:approve.querySelectorAll('svg path,svg polyline').length,color:getComputedStyle(icon).color,center:Math.abs(i.y+i.height/2-button.y-button.height/2),text:approve.textContent.trim()}})()`);
    check(metrics.left >= 14 && metrics.right >= 14 && metrics.gap >= 9 && metrics.aligned, `${width}: trigger padding/alignment ${JSON.stringify(metrics)}`);
    check(metrics.height >= 44 && metrics.labelGap >= 4 && !metrics.overflow, `${width}: label spacing/touch target/containment ${JSON.stringify(metrics)}`);
    check(metrics.marks === 1 && metrics.color === "rgb(255, 255, 255)" && metrics.center < 1 && metrics.text === "Approve & Schedule", `${width}: one centered white check and unchanged label`);
    await evaluate("document.querySelector('.staff-request-doctor-trigger').focus()"); await key("Enter", "Enter", 13);
    check(await evaluate("document.querySelector('.staff-request-doctor-trigger').getAttribute('aria-expanded')==='true'"), `${width}: keyboard opens menu; focus ${await evaluate("document.activeElement?.className")}`);
    const menu = await evaluate(`(()=>{const e=document.querySelector('.staff-request-doctor-menu'),r=e.getBoundingClientRect(),options=[...e.querySelectorAll('button')],first=options[0],f=first.getBoundingClientRect(),i=first.querySelector('svg').getBoundingClientRect();return {left:r.left,right:r.right,scroll:e.scrollHeight>e.clientHeight,count:options.length,leftPad:i.left-f.left,selected:options.filter(b=>b.getAttribute('aria-checked')==='true').length,overlap:[...document.querySelectorAll('.doctor-request-status-card footer button')].some(b=>{const s=b.getBoundingClientRect();return r.left<s.right&&r.right>s.left&&r.top<s.bottom&&r.bottom>s.top})}})()`);
    check(menu.left >= 0 && menu.right <= width && menu.count === 11 && menu.scroll && menu.selected === 1 && menu.leftPad >= 8, `${width}: contained scrollable options and selection`);
    if (width <= 700) check(!menu.overlap, `${width}: expanded menu clears important actions`);
    if ([375, 1366].includes(width)) { const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(join(temporary, `details-open-${width}.png`), Buffer.from(screenshot.data, "base64")); }
    await key("Escape", "Escape", 27);
    check(await evaluate("!document.querySelector('.staff-request-doctor-menu')&&document.activeElement===document.querySelector('.staff-request-doctor-trigger')"), `${width}: Escape closes and restores focus`);
    await click(".staff-request-doctor-trigger"); await click(".staff-request-doctor-menu button:last-child");
    check(await evaluate("document.querySelector('.staff-request-doctor-trigger span').textContent==='Dr. Synthetic Doctor With A Longer Display Name'&&!document.querySelector('.staff-request-doctor-menu')"), `${width}: doctor selection works`);
    await click(".staff-request-doctor-trigger"); await click(".staff-request-doctor-menu button:first-child");
    check(await evaluate("document.querySelector('.doctor-request-approve-button').disabled"), `${width}: assignment remains required`);
    await click(".staff-request-doctor-trigger"); await key("Tab", "Tab", 9);
    check(await evaluate("document.activeElement.matches('[role=menuitemradio]')"), `${width}: options reachable with Tab`);
    await key("Tab", "Tab", 9); await key("Enter", "Enter", 13);
    check(await evaluate("!document.querySelector('.doctor-request-approve-button').disabled"), `${width}: keyboard selection enables approval`);
    await click(".doctor-request-approve-button"); await click(".doctor-request-decline-button"); await click(".doctor-request-back-button");
    await click(".doctor-request-message-button");
    check(await evaluate("!!document.querySelector('[role=dialog]')"), `${width}: Message Patient opens safe preview`);
    await click("[role=dialog] button");
    check(await evaluate("window.staffDetailsUi.events.some(e=>e[0]==='approve'&&e[1]===123)&&window.staffDetailsUi.events.some(e=>e[0]==='decline'&&e[1]===123)&&window.staffDetailsUi.events.some(e=>e[0]==='back')"), `${width}: action callbacks preserved (mocks only)`);
    await evaluate("window.staffDetailsUi.updating(true)");
    check(await evaluate("document.querySelector('.doctor-request-approve-button').disabled&&document.querySelector('.doctor-request-decline-button').disabled&&document.querySelector('.staff-request-doctor-trigger').disabled"), `${width}: updating guards retained`);
    await evaluate("window.staffDetailsUi.updating(false)");
    check(await evaluate("window.staffDetailsUi.errors.length===0"), `${width}: no runtime errors`); scenarios++;
  }
  console.log(`PASS: ${scenarios} viewport/interaction scenarios; ${assertions} assertions. Actual details component, synthetic data; no authenticated Supabase or notification testing.`);
  console.log(`Screenshots: ${join(temporary, "details-open-375.png")} and ${join(temporary, "details-open-1366.png")}`);
} finally { socket?.close(); browser.kill(); }
