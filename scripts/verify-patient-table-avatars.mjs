// Actual table-avatar JSX and loaded styles; synthetic images, no Supabase or uploads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "espree";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFile(join(root, file), "utf8");
const staff = await read("src/pages/staff/Staff_Patients.jsx");
const doctor = await read("src/pages/doctor/Doctor_Patients.jsx");
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
  return null;
}
const ast = source => parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
const avatar = find(ast(staff), node => node.type === "JSXElement" && node.openingElement.attributes.some(
  attr => attr.name?.name === "className" && attr.value?.expression?.quasis?.[0]?.value.raw.startsWith("staff-patient-avatar ")));
const doctorAvatar = find(ast(doctor), node => node.type === "FunctionDeclaration" && node.id?.name === "PatientAvatar");
assert(avatar && doctorAvatar, "Existing table avatar implementations found");
const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';
function StaffAvatar({patient}){return ${staff.slice(...avatar.range)}}
${doctor.slice(...doctorAvatar.range)}
window.avatarTest={errors:[]};window.addEventListener('error',e=>window.avatarTest.errors.push(e.message));
const image=(w,h)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="pink"/><circle cx="'+w/2+'" cy="'+h/2+'" r="'+Math.min(w,h)/4+'" fill="#cf3675"/></svg>');
const photos=[image(120,1800),image(1600,200),image(200,200),image(300,900),''];
function App(){return <>{['Staff','Doctor'].map(role=><main key={role} data-role={role} className={role==='Staff'?'staff-dashboard-shell':''}>
<section className={role==='Staff'?'staff-patients-page patient-directory':'doctor-patients-page doctor-patients-list-page'}>
<div className={role==='Staff'?'staff-patients-card':'doctor-patients-table-card'}>
<div className={role==='Staff'?'staff-patients-table-xscroll':'doctor-patients-table-scroll'}>
<table className={role==='Staff'?'staff-patients-table':'doctor-patients-table'}><tbody>{photos.map((photo,i)=>{
const patient={photo,name:'Synthetic Patient '+i,initials:'SP',tone:'pink',avatarClass:'patient-avatar-pink'};
return <tr key={i}><td><div className={role==='Staff'?'staff-patient-info-cell':'doctor-patient-info-cell'}>
{role==='Staff'?<StaffAvatar patient={patient}/>:<PatientAvatar patient={patient}/>}<strong>{patient.name}</strong></div></td><td><button type="button">View</button></td></tr>;})}</tbody></table>
</div></div></section></main>)}</>}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle = await build({ root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-table-avatar", resolveId: id => id.endsWith("avatar-fixture.jsx") ? "\0avatar-fixture.jsx" : null,
    load: id => id === "\0avatar-fixture.jsx" ? fixture : null }],
  build: { write: false, minify: false, lib: { entry: "avatar-fixture.jsx", formats: ["es"] } } });
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output);
const code = outputs.find(output => output.type === "chunk").code.replaceAll("</script", "<\\/script");
const styles = (await Promise.all(["index.css", "styles/doctor-dashboard.css", "styles/staff-dashboard.css", "styles/doctor-patients.css",
  "styles/patient-record-ui-system.css", "styles/staff-patients.css", "styles/staff-settings.css", "styles/staff-doctor-parity.css"]
  .map(file => read("src/" + file)))).join("\n").replace(/@import\s+url\([^)]*\)\s*;/g, "");
const temporary = await mkdtemp(join(tmpdir(), "maternal-table-avatars-")), html = join(temporary, "fixture.html");
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}
body{margin:0}main{padding:12px}*{box-sizing:border-box}</style><div id="root"></div><script type="module">${code}</script>`);
let executable;
for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
  try { await access(candidate); executable = candidate; break; } catch { /* Try the next installed browser. */ }
}
assert(executable, "Chrome/Chromium required for image geometry verification");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
  "--remote-debugging-port=0", `--user-data-dir=${join(temporary, "profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
let socket, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
try {
  let port;
  for (let i = 0; i < 160 && !port; i++) { try { port = (await readFile(join(temporary, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await pause(); } }
  assert(port, "Isolated browser started");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(Error(JSON.stringify(m.error))); else p.resolve(m.result); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method)); }, 5000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await cdp("Runtime.evaluate", { expression, returnByValue: true });
    assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp("Network.enable"); await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Page.navigate", { url: pathToFileURL(html).href });
  for (let i = 0; i < 120; i++) { if (await evaluate("document.querySelectorAll('img').length===8&&[...document.images].every(i=>i.complete&&i.naturalWidth>0)")) break; await pause(); }
  for (const width of [320, 390, 768, 1366]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
    for (const role of ["Staff", "Doctor"]) {
      const measurements = await evaluate(`(()=>{const main=document.querySelector('[data-role="${role}"]');return [...main.querySelectorAll('tr')].map(tr=>{
const a=tr.querySelector('[class*="patient-avatar"]'),r=a.getBoundingClientRect(),s=getComputedStyle(a),i=a.querySelector('img'),b=i?.getBoundingClientRect(),c=i&&getComputedStyle(i),row=tr.getBoundingClientRect();
return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,rowTop:row.top,rowBottom:row.bottom,clip:s.overflow,radius:s.borderRadius,text:a.textContent,src:i?.getAttribute('src'),image:b&&{w:b.width,h:b.height,top:b.top,left:b.left,right:b.right,bottom:b.bottom,fit:c.objectFit,position:c.objectPosition},left:r.left,right:r.right};});})()`);
      check(measurements.length === 5, `${width}/${role}: all photo shapes and initials rendered`);
      for (const [i, a] of measurements.entries()) {
        check(a.w === a.h && a.w >= 40 && a.w <= 52, `${width}/${role}/${i}: fixed circular avatar`);
        check(a.clip === "hidden" && ["50%", "999px"].includes(a.radius), `${width}/${role}/${i}: circular clipping`);
        check(a.top >= a.rowTop && a.bottom <= a.rowBottom, `${width}/${role}/${i}: avatar stays inside its row`);
        if (a.image) {
          check(a.image.w === a.w && a.image.h === a.h, `${width}/${role}/${i}: image matches circle; ${JSON.stringify(a)}`);
          check(a.image.fit === "cover" && a.image.position === "50% 50%", `${width}/${role}/${i}: centered cover without distortion`);
          check(a.src.startsWith("data:image/svg+xml,"), `${width}/${role}/${i}: source URL unchanged`);
        } else check(a.text === "SP", `${width}/${role}: initials preserved`);
        if (i) check(a.rowTop >= measurements[i - 1].rowBottom, `${width}/${role}/${i}: adjacent rows do not overlap`);
      }
    }
    if (width === 390 || width === 1366) await writeFile(join(temporary, `avatars-${width}.png`), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  check(await evaluate("window.avatarTest.errors.length===0"), "No browser errors");
  console.log(`PASS: ${checks} browser avatar assertions. Actual avatar JSX/CSS; synthetic portrait, landscape, square, existing URL and initials at four widths. No live photos or uploads. Screenshots: ${temporary}`);
} finally { socket?.close(); browser.kill(); }
