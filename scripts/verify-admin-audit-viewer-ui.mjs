// Actual Audit Logs page, synthetic data/Auth, blocked external network, headless Chrome.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import postcss from "postcss";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const data = `import React from 'react';
export function useAdminAuditLogs(filters){
 const [,render]=React.useState(0);window.auditUi.render=()=>render(x=>x+1);window.auditUi.filters=filters;
 const row={id:'synthetic-event',actor_name:'Synthetic Admin',actor_role:'admin',module:'authentication',action:'login',status:'reported',created_at:'2026-10-18T00:00:00Z',description:'Synthetic client report. <img src=x onerror=window.auditInjected=true>',request_id:'11111111-1111-4111-8111-111111111111',previous_status:'active',new_status:'inactive',metadata:{password:'NEVER_RENDER_PRIVATE_METADATA',clinical_notes:'NEVER_RENDER_CLINICAL_METADATA'}};
 const mode=window.auditUi.mode;
 if(mode==='production-source'){row.status='success';row.audit_source='server_transaction';}
 if(mode==='staging-client'){row.status='success';row.event_origin='client_reported';}
 if(mode==='staging-server'){row.status='success';row.event_origin='server_verified';}
 return {rows:['denied','empty','loading'].includes(mode)?[]:[row],analyticsRows:[row],actorRows:[{...row,actor_user_id:'synthetic-admin'}],count:mode==='empty'?0:24,
 canDisplay:mode!=='denied',pageSize:10,pageLoading:mode==='loading',analyticsLoading:mode==='loading',refreshing:mode==='refreshing',
 stale:mode==='stale',error:['stale','denied'].includes(mode)?{code:mode==='denied'?'42501':'08006'}:null,
 migrationRequired:false,updatesAvailable:mode==='updates',realtimeError:'',truncated:true,actorTruncated:true,
 refresh:()=>{window.auditUi.refreshes++;}};
}`;
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';
import Page from '${root}/src/pages/admin/AdminAuditLogs.jsx';
window.auditUi={mode:'normal',refreshes:0,errors:[]};
window.addEventListener('error',e=>window.auditUi.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.auditUi.errors.push(String(e.reason)));
createRoot(document.getElementById('root')).render(<div style={{padding:16}}><Page/></div>);`;
const result = await build({ root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "offline-audit-page", enforce: "pre",
  resolveId(id) {
    if (id.endsWith("audit-viewer-fixture.jsx")) return "\0audit-viewer-fixture.jsx";
    if (/\/useAdminAuth(?:\.js)?$/.test(id)) return "\0audit-viewer-auth.js";
    if (/\/useAdminAuditLogs(?:\.js)?$/.test(id)) return "\0audit-viewer-data.js";
    if (/\/supabaseClient(?:\.js)?$/.test(id)) throw Error("Real Supabase dependency forbidden");
  }, load(id) {
    if (id === "\0audit-viewer-fixture.jsx") return fixture;
    if (id === "\0audit-viewer-auth.js") return "export function useAdminAuth(){return {isAdmin:true,user:{id:'synthetic-admin'}}}";
    if (id === "\0audit-viewer-data.js") return data;
  } }, react()], build: { write: false, minify: false, lib: { entry: "audit-viewer-fixture.jsx", formats: ["es"] } } });
const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
const css = postcss.parse(output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n"));
css.walkAtRules("import", rule => rule.remove());
const code = output.find(item => item.type === "chunk").code.replaceAll("</script", "<\\/script");
const temp = await mkdtemp(join(tmpdir(), "maternal-audit-viewer-"));
const html = join(temp, "fixture.html");
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${code}</script>`);
let executable;
for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
  try { await access(candidate); executable = candidate; break; } catch { /* next installed browser */ }
}
assert.ok(executable, "Installed Chrome required");
const browser = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(temp,"profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket, assertions = 0;
const check = (ok, label) => { assert.ok(ok, label); assertions++; };
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) { try { port = (await readFile(join(temp,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]; } catch { await pause(); } }
  assert.ok(port, "Chrome starts");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => { const msg = JSON.parse(event.data), request = pending.get(msg.id); if (!request) return; pending.delete(msg.id); if (msg.error) request.reject(Error(JSON.stringify(msg.error))); else request.resolve(msg.result); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); setTimeout(() => { if (pending.delete(id)) reject(Error(`Timeout: ${method}`)); },5000).unref(); });
  const evaluate = async expression => { const r = await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true}); assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp("Network.enable"); await cdp("Network.setBlockedURLs",{urls:["http://*","https://*"]});
  await cdp("Page.navigate",{url:new URL(`file:///${html.replaceAll("\\","/")}`).href});
  for (let i=0;i<50;i++) { if (await evaluate("!!window.auditUi?.render")) break; await pause(); }
  check(await evaluate("!!document.querySelector('.admin-audit-table-card')"), "Actual page mounted with synthetic data");
  for (const width of [320,360,390,768,1024,1366,1440]) {
    await cdp("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false}); await pause();
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth"),`${width}: page has no horizontal overflow`);
    check(await evaluate("document.querySelectorAll('.admin-audit-filter-actions button').length===2&&[...document.querySelectorAll('.admin-audit-filter-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.width>30&&r.left>=0&&r.right<=innerWidth})"),`${width}: Refresh and Reset remain visible`);
    check(await evaluate("[...document.querySelectorAll('.admin-audit-filter')].some(l=>l.querySelector('span')?.textContent==='Role'&&l.querySelector('select')?.options.length===5)"),`${width}: all five Role choices are present`);
    await evaluate("document.querySelector('.admin-audit-details-button').click()"); await pause();
    check(await evaluate("(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<=innerHeight&&d.scrollWidth<=d.clientWidth})()"),`${width}: details fit the viewport without horizontal overflow`);
    await evaluate("document.querySelector('[aria-label=\"Close audit event details\"]').click()"); await pause();
    check(await evaluate("!document.querySelector('[role=dialog]')"),`${width}: details close button works`);
  }
  await evaluate("document.querySelector('button[aria-label=\"Next page\"]').click()"); await pause();
  check(await evaluate("window.auditUi.filters.page===2"),"Real page-change callback selects page two");
  await evaluate("document.querySelector('.admin-audit-filter select').value='synthetic-admin';document.querySelector('.admin-audit-filter select').dispatchEvent(new Event('change',{bubbles:true}))"); await pause();
  check(await evaluate("window.auditUi.filters.page===1&&window.auditUi.filters.user==='synthetic-admin'"),"User filter resets pagination and retains selection");
  for (const role of ['admin','doctor','staff','patient']) {
    await evaluate("document.querySelector('button[aria-label=\"Next page\"]').click()"); await pause();
    await evaluate(`(()=>{const s=[...document.querySelectorAll('.admin-audit-filter')].find(l=>l.querySelector('span')?.textContent==='Role').querySelector('select');s.value=${JSON.stringify(role)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause();
    check(await evaluate(`window.auditUi.filters.role===${JSON.stringify(role)}&&window.auditUi.filters.page===1&&window.auditUi.filters.user==='synthetic-admin'`),`${role}: Role change resets page and preserves User`);
  }
  await evaluate("document.querySelector('.admin-audit-filter-actions button').click()"); await pause();
  check(await evaluate("['user','role','module','action'].every(k=>window.auditUi.filters[k]==='all')&&window.auditUi.filters.page===1"),"Reset clears Role and existing filters");
  await evaluate("document.querySelector('.admin-audit-details-button').focus()");
  await evaluate("document.querySelector('.admin-audit-details-button').click()"); await pause();
  check(await evaluate("document.querySelector('[role=dialog]').textContent.includes('Client reported (unverified)')&&document.querySelector('[role=dialog]').textContent.includes('Previous Account Status')"),"Real details modal renders whitelisted source/change fields");
  check(await evaluate("!window.auditInjected&&!document.querySelector('[role=dialog] img')&&!document.querySelector('[role=dialog]').textContent.includes('NEVER_RENDER')&&document.querySelector('[role=dialog]').textContent.includes('<img src=x')"),"Descriptions render as text and private raw metadata is omitted");
  check(await evaluate("document.activeElement.getAttribute('aria-label')==='Close audit event details'"),"Details receives keyboard focus");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9}); await pause();
  check(await evaluate("document.activeElement===document.querySelector('[role=dialog] footer button')"),"Shift Tab stays within modal");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await pause();
  check(await evaluate("!document.querySelector('[role=dialog]')"),"Escape closes details");
  check(await evaluate("document.activeElement.classList.contains('admin-audit-details-button')&&document.body.style.overflow!== 'hidden'"),"Closing restores focus and scroll locking");
  for (const [mode, label] of [["production-source","Server transaction (metadata marker)"], ["staging-client","Client reported (unverified)"], ["staging-server","Server verified"]]) {
    await evaluate(`window.auditUi.mode=${JSON.stringify(mode)};window.auditUi.render()`); await pause();
    await evaluate("document.querySelector('.admin-audit-details-button').click()"); await pause();
    check(await evaluate(`document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(label)})`), `${mode}: actual details use the correct source representation`);
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await pause();
  }
  await evaluate("window.auditUi.mode='stale';window.auditUi.render()"); await pause();
  check(await evaluate("document.body.textContent.includes('Refresh failed. Showing previously loaded audit data.')&&!!document.querySelector('.admin-audit-table-card')"),"Stale error banner keeps cached table visible");
  check(await evaluate("!document.querySelector('.admin-audit-summary-grid,.admin-audit-chart-grid')&&document.querySelector('.admin-audit-table-footer p').textContent.includes('24')"),"Statistics and charts stay removed while the table retains its filtered total");
  await evaluate("window.auditUi.mode='updates';window.auditUi.render()"); await pause();
  check(await evaluate("document.body.textContent.includes('New activity may be available')"),"Deferred update notice is visible");
  await evaluate("[...document.querySelectorAll('.admin-audit-filter-actions button')].find(b=>b.textContent==='Refresh').click()");
  check(await evaluate("window.auditUi.refreshes===1"),"Manual Refresh invokes existing handler once");
  await evaluate("window.auditUi.mode='refreshing';window.auditUi.render()"); await pause();
  check(await evaluate("document.querySelectorAll('.admin-audit-filter-actions button')[1].disabled&&document.querySelectorAll('.admin-audit-filter-actions button')[1].textContent==='Refreshing...'"),"Refresh feedback disables repeated clicks");
  await evaluate("window.auditUi.mode='empty';window.auditUi.render()"); await pause();
  check(await evaluate("!!document.querySelector('.admin-audit-empty')&&!document.querySelector('.admin-audit-table-card')"),"Empty state remains visible");
  await evaluate("window.auditUi.mode='loading';window.auditUi.render()"); await pause();
  check(await evaluate("!!document.querySelector('.admin-audit-loading')&&!document.querySelector('.admin-audit-table-card')"),"Initial loading state remains visible");
  await evaluate("window.auditUi.mode='normal';window.auditUi.render()"); await pause();
  await evaluate("document.querySelector('.admin-audit-details-button').click();window.auditUi.mode='denied';window.auditUi.render()"); await pause();
  check(await evaluate("!document.querySelector('.admin-audit-table-card')&&!document.querySelector('[role=dialog]')"),"Permission loss hides cached rows and an open details dialog");
  check(await evaluate("window.auditUi.errors.length===0"),"No browser errors or unhandled rejections");
  console.log(`PASS: actual Audit Logs page, 7 viewports, ${assertions} assertions; 0 failures. Offline synthetic Auth/data; external network blocked.`);
} finally { socket?.close(); browser.kill(); }
