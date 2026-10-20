// Offline Chrome fixture: actual progress JSX, installed Check icon and booking CSS.
// No application auth, Supabase, booking mutations or Android/build output writes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transformWithOxc } from "vite";
import { verifyWizardReviewNavigation } from "./verify-wizard-review-navigation.mjs";

const navigationAssertions = await verifyWizardReviewNavigation();

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const source = await readFile(new URL("../src/components/patient/PatientBookAppointment.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles/patientbookappointment.css", import.meta.url), "utf8");
const staffSource = await readFile(new URL("../src/pages/staff/Staff_Patients.jsx", import.meta.url), "utf8");
const staffCss = await readFile(new URL("../src/styles/staff-patients.css", import.meta.url), "utf8");
const steps = source.match(/const STEPS = \[[^;]+;/)?.[0];
const start = source.indexOf('<ol className="patient-booking-stepper"');
const end = source.indexOf("</ol>", start);
assert.ok(steps && start >= 0 && end > start, "Actual progress markup located");
const footerStart = source.indexOf('<footer className="patient-booking-actions">');
const footer = source.slice(footerStart, source.indexOf('</footer>', footerStart) + 9);
const staffButton = staffSource.indexOf('onClick={() => continueRegistrationStep(3)}');
const staffFooterStart = staffSource.lastIndexOf('<footer', staffButton);
const staffFooter = staffSource.slice(staffFooterStart, staffSource.indexOf('</footer>', staffButton) + 9);
assert.ok(footerStart > 0 && staffButton > 0, 'Actual Patient and Staff action markup located');
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {Check} from 'lucide-react';
${steps}
window.bookingProgress={errors:[],actions:0};
window.addEventListener('error',event=>window.bookingProgress.errors.push(event.message));
function Icon(){return <svg width="18" height="18" aria-hidden="true"/>}
function Progress({step}){
const isEditingFromReview=true,isSubmitting=false,canContinue=true,hasValidBookingDetails=true,hasCurrentAvailability=true;
const continueBooking=()=>{window.bookingProgress.actions++;window.bookingProgress.show(4);};
const submitBooking=()=>{},navigate=()=>{},setStep=value=>window.bookingProgress.show(typeof value==='function'?value(step):value);
return <main className="patient-booking-page">${source.slice(start, end + 5)}
<div className="patient-booking-card"><section className="patient-booking-panel"><h2>Step {step} content</h2></section></div>${footer}</main>}
function StaffControls(){const isEditingRegistrationReview=true;
const moveToRegistrationStep=()=>{},continueRegistrationStep=()=>{window.bookingProgress.actions++;};
return <main className="staff-dashboard-shell"><section className="staff-register-page"><div className="staff-register-card">${staffFooter}</div></section></main>}
const root=createRoot(document.getElementById('root'));
window.bookingProgress.show=step=>flushSync(()=>root.render(<Progress step={step}/>));
window.bookingProgress.showStaff=()=>flushSync(()=>root.render(<StaffControls/>));
window.bookingProgress.show(1);`;
const compiled = (await transformWithOxc(fixture, "booking-progress-fixture.jsx", { jsx: { runtime: "automatic" } })).code;
const bundle = await build({ root, configFile: false, logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-booking-progress",
    resolveId(id) { if (id.endsWith("booking-progress-fixture.js")) return "\0booking-progress-fixture.js"; },
    load(id) { if (id === "\0booking-progress-fixture.js") return compiled; },
  }], build: { write: false, minify: false, lib: { entry: "booking-progress-fixture.js", formats: ["es"] } },
});
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output);
const code = outputs.find(entry => entry.type === "chunk").code.replaceAll("</script", "<\\/script");
const temporary = await mkdtemp(join(tmpdir(), "maternal-booking-progress-"));
const html = join(temporary, "fixture.html");
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{margin:0;padding:12px;font-family:Arial,sans-serif;background:#f7f9fc}
.patient-booking-page{margin:0 auto}${css}${staffCss}</style><div id="root"></div><script type="module">${code}</script>`);
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
  for (let i = 0; i < 160 && !port; i++) {
    try { port = (await readFile(join(temporary, "browser-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await pause(); }
  }
  assert.ok(port, "Isolated browser started");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let sequence = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return; pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error("Offline browser connection closed")); }
    pending.clear();
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(Error(`Browser timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Page.navigate", { url: pathToFileURL(html).href });
  for (let i = 0; i < 160; i++) { if (await evaluate("!!window.bookingProgress?.show")) break; await pause(); }
  check(await evaluate("!!window.bookingProgress?.show"), "Actual progress markup mounted offline");
  for (const width of [320, 375, 390, 414, 768, 780, 781, 1024, 1366, 1920]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 600, deviceScaleFactor: 1, mobile: false });
    for (const step of [1, 2, 3, 4]) {
      await evaluate(`window.bookingProgress.show(${step})`);
      const state = await evaluate(`(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        const rows=[...document.querySelectorAll('.patient-booking-stepper li')].map((li,index)=>{
          const circle=li.querySelector(':scope > span'),label=li.querySelector('strong'),r=rect(li),c=rect(circle),l=rect(label);
          const style=getComputedStyle(li,'::after'),w=parseFloat(style.width)||0,h=parseFloat(style.height)||0;
          const x=style.position==='absolute'?r.left+parseFloat(style.left):r.right-(parseFloat(style.marginRight)||0)-w;
          const y=style.position==='absolute'?r.top+parseFloat(style.top):r.top+(r.height-h)/2;
          return {circle:c,label:l,text:label.textContent,visible:getComputedStyle(label).display!=='none',
            labelOverflow:label.scrollWidth>label.clientWidth,number:circle.textContent,
            active:li.getAttribute('aria-current'),complete:li.classList.contains('is-complete'),
            svgs:circle.querySelectorAll('svg').length,marks:circle.querySelectorAll('svg path,svg polyline').length,
            icon:circle.querySelector('svg')?rect(circle.querySelector('svg')):null,
            connector:index<3?{left:x,right:x+w,top:y,bottom:y+h,width:w}:null};
        });
        return {rows,errors:window.bookingProgress.errors,overflow:document.documentElement.scrollWidth>innerWidth,
          card:rect(document.querySelector('.patient-booking-card'))};
      })()`);
      const label = `${width}px step ${step}`;
      check(!state.overflow && state.errors.length === 0, `${label}: no overflow/runtime error`);
      check(state.rows.map(row => row.text).join("|") === "Service|Doctor|Date & Time|Review", `${label}: all labels retained`);
      for (const [index, row] of state.rows.entries()) {
        const complete = index + 1 < step;
        check(row.complete === complete && row.svgs === (complete ? 1 : 0) && row.marks === (complete ? 1 : 0), `${label}: one check only in completed circle ${index}`);
        check(row.number === (complete ? "" : String(index + 1)) && row.active === (index + 1 === step ? "step" : null), `${label}: active/upcoming numbers ${index}`);
        check(row.visible && !row.labelOverflow && row.label.left >= 0 && row.label.right <= width, `${label}: readable label ${index}`);
        check(row.circle.left >= 0 && row.circle.right <= width && row.circle.width === 34 && row.circle.height === 34, `${label}: circle size/containment ${index}`);
        if (row.icon) check(Math.abs((row.icon.left+row.icon.right-row.circle.left-row.circle.right)/2)<1 &&
          Math.abs((row.icon.top+row.icon.bottom-row.circle.top-row.circle.bottom)/2)<1, `${label}: centered check ${index}`);
        if (width <= 780) check(Math.abs((row.label.left+row.label.right-row.circle.left-row.circle.right)/2)<1 &&
          row.label.top >= row.circle.bottom+6 && state.card.top >= row.label.bottom+6, `${label}: mobile label spacing ${index}`);
        if (row.connector) {
          check(row.connector.width > 0, `${label}: connector visible ${index}`);
          for (const other of state.rows) for (const area of [other.circle, other.label]) {
            const intersects = row.connector.left < area.right && row.connector.right > area.left &&
              row.connector.top < area.bottom && row.connector.bottom > area.top;
            check(!intersects, `${label}: connector avoids labels/circles ${index}`);
          }
        }
      }
      scenarios++;
      if (step === 4 && [320, 1366].includes(width)) {
        const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
        await writeFile(join(temporary, `progress-${width}.png`), Buffer.from(screenshot.data, "base64"));
      }
    }
  }
  for (const role of ['patient','staff']) {
    for (const width of [320,768,1366]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:false});
      await evaluate(role==='patient'?'window.bookingProgress.show(1)':'window.bookingProgress.showStaff()');
      await cdp('Page.bringToFront');
      const selector=role==='patient'?'.patient-booking-actions .is-primary':'.staff-next-btn';
      const action=await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();b.focus();
        return {text:b.textContent,focused:document.activeElement===b,visible:r.width>0&&r.height>=44,
          fits:r.left>=0&&r.right<=innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,actions:window.bookingProgress.actions};})()`);
      check(action.text.includes('Return to Review')&&action.focused&&action.visible,`${role} ${width}: native return control visible and focusable`);
      check(action.fits&&!action.overflow,`${role} ${width}: edited footer fits viewport`);
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
      await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      check(await evaluate('window.bookingProgress.actions')===action.actions+1,`${role} ${width}: Enter activates return once`);
    }
  }
  console.log(`PASS: ${scenarios} step/viewport cases; ${assertions} layout/keyboard assertions; ${navigationAssertions} navigation assertions. Offline fixtures only; no authenticated backend testing.`);
  console.log(`Visual samples: ${join(temporary, "progress-320.png")} and ${join(temporary, "progress-1366.png")}`);
} finally { socket?.close(); browser.kill(); }
