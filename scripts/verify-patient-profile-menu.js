/* global process */
// Run: node scripts/verify-patient-profile-menu.js
// Uses an installed Chrome/Chromium, or the executable named by HEADLESS_BROWSER.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const source = await readFile(join(root, "src/pages/patient/Patient_PWA.jsx"), "utf8");
assert.ok(source.includes("function TopProfile("), "TopProfile must be tested from current source");
const profileSource = `import {useEffect,useRef,useState} from 'react';
import {Icon} from '@iconify/react';
${source.slice(source.indexOf("function TopProfile(")).replace("function TopProfile(", "export default function TopProfile(")}`;

// No backend, native plugin, auth session, or real notification data is used.
const mockSource = `
let rows = [], listeners = [];
export const state = {readCalls: 0};
export function insert() {
  const row = {id: 'fixture-notification', patient_id: 'fixture-patient',
    type: 'general', title: 'Synthetic update', message: 'Synthetic test',
    priority: 'normal', read_at: null, created_at: new Date().toISOString()};
  rows = [row];
  listeners.forEach(callback => callback({new: row}));
}
export const supabase = {
  from() { return {select() {return this}, eq() {return this}, order() {return this},
    async limit() {return {data: [...rows], error: null}}} },
  channel() {
    let active = true;
    return {on(event, options, callback) {
      if (options.event === 'INSERT') listeners.push(payload => active && callback(payload));
      return this;
    }, subscribe(callback) {callback('SUBSCRIBED'); return this}, stop() {active = false}};
  },
  removeChannel(channel) {channel.stop()},
  async rpc() {state.readCalls++; return {data: null, error: null}}
};`;

const fixture = `
import {useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {_api} from '@iconify/react';
import Provider from '${root}/src/components/patient/PatientNotificationsProvider.jsx';
import Bell from '${root}/src/components/patient/PatientNotificationBell.jsx';
import TopProfile from 'profile-test-component';
import {insert,state} from 'profile-test-supabase';
_api.setFetch(async () => ({status: 404}));
const reports = [], failures = [], bellNavigations = [];
let assertions = 0, logouts = 0, mounts = 0, unmounts = 0;
const check = (condition, message) => {assertions++; if (!condition) failures.push(message)};
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
function TrackedBell({onNavigate}) {
  useEffect(() => {mounts++; return () => {unmounts++}}, []);
  return <Bell onNavigate={onNavigate}/>;
}
function Shell() {
  const [profileOpen,setProfileOpen] = useState(false);
  const [page,setPage] = useState('dashboard');
  const report = useCallback(open => {reports.push(open); setProfileOpen(open)}, []);
  return <Provider patientId="fixture-patient"><div className="pwa-shell">
    <aside className="pwa-sidebar"/>
    <main className={'pwa-main ' + (profileOpen ? 'is-profile-open' : '')} data-page={page}>
      <header className="pwa-topbar">
        <button className="pwa-mobile-brand">Maternal Care</button>
        <div className="pwa-topbar-actions">
          <TrackedBell onNavigate={path => {bellNavigations.push(path); setPage(path)}}/>
          <TopProfile profile={{displayName: 'Test', avatar: ''}} onOpenChange={report}
            onNavigate={setPage} onLogout={async () => {logouts++}}/>
          <div className="pwa-topbar-secondary"/>
        </div>
      </header>
      <div className="pwa-content">
        <button id="outside">Outside profile menu</button>
        {['dashboard','records','visits','reminders'].map(destination =>
          <button key={destination} id={'go-' + destination} onClick={() => setPage(destination)}>
            {destination}
          </button>)}
      </div>
    </main>
  </div></Provider>;
}
const trigger = () => document.querySelector('.pwa-profile-pill');
const center = () => document.querySelector('.pwa-notification-center');
const parentOpen = () => document.querySelector('.pwa-main').classList.contains('is-profile-open');
async function openMenu() {
  trigger().click(); await pause();
  check(reports.at(-1) === true && parentOpen(), 'open reports true to parent');
  check(trigger().getAttribute('aria-expanded') === 'true', 'menu genuinely open');
  check(!!document.querySelector('.pwa-notification-bell') && mounts === 1 && unmounts === 0,
    'open menu keeps bell mounted');
  if (matchMedia('(max-width:780px)').matches) {
    check(getComputedStyle(center()).opacity === '0', 'open menu hides bell on mobile');
    check(getComputedStyle(center()).pointerEvents === 'none', 'open menu disables bell on mobile');
  } else {
    check(getComputedStyle(center()).opacity === '1', 'desktop bell remains visible while menu open');
  }
}
function closed(label) {
  check(reports.at(-1) === false && !parentOpen(), label + ': reports false to parent');
  check(trigger().getAttribute('aria-expanded') === 'false', label + ': menu closed');
  check(getComputedStyle(center()).opacity === '1', label + ': bell restored');
  check(getComputedStyle(center()).pointerEvents !== 'none', label + ': bell enabled');
  check(!!document.querySelector('.pwa-notification-bell > svg'), label + ': bundled SVG present');
  check(mounts === 1 && unmounts === 0, label + ': bell restored without remount');
}
const menuItem = label => [...document.querySelectorAll('[role="menuitem"]')]
  .find(item => item.textContent.trim() === label);
flushSync(() => createRoot(document.querySelector('#root')).render(<Shell/>));
await pause(); closed('initial');
await openMenu(); trigger().click(); await pause(); closed('normal toggle');
for (const label of ['Profile','Settings']) {
  await openMenu(); menuItem(label).click(); await pause(); closed('select ' + label);
  check(document.querySelector('.pwa-main').dataset.page === label.toLowerCase(), label + ': navigation retained');
}
await openMenu();
document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
await pause(); closed('outside pointerdown');
await openMenu(); document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
await pause(); closed('Escape');
await openMenu(); menuItem('Log out').click(); await pause(); closed('logout');
check(logouts === 1, 'logout callback invoked once');
for (const destination of ['dashboard','records','visits','reminders']) {
  await openMenu(); menuItem('Profile').click(); await pause(); closed('Profile before ' + destination);
  document.querySelector('#go-' + destination).click(); await pause(); closed('Profile to ' + destination);
  check(document.querySelector('.pwa-main').dataset.page === destination, destination + ': navigation retained');
}
insert(); insert(); await pause(); closed('foreground unread INSERT with menu closed');
check(document.querySelector('.pwa-notification-badge')?.textContent === '1', 'unread badge updates without duplicates');
check(state.readCalls === 0 && bellNavigations.length === 0, 'receipt does not mark read or navigate');
check(!document.querySelector('#patient-notification-panel'), 'receipt does not open notification panel');
await openMenu(); insert(); await pause();
check(getComputedStyle(center()).opacity === (matchMedia('(max-width:780px)').matches ? '0' : '1'),
  'foreground receipt preserves genuinely open menu visibility');
trigger().click(); await pause(); closed('close menu after foreground receipt');
check(document.querySelector('.pwa-notification-badge')?.textContent === '1', 'closing menu restores unread badge');
document.querySelector('.pwa-notification-bell').click(); await pause();
check(document.querySelectorAll('.pwa-notification-item').length === 1, 'inbox presents notification once');
check(document.querySelectorAll('.pwa-notification-item.is-unread').length === 1, 'opening inbox leaves notification unread');
check(!!document.querySelector('body > .pwa-notification-mobile-portal') === matchMedia('(max-width:768px)').matches,
  'mobile portal and desktop panel placement preserved');
check(state.readCalls === 0, 'opening inbox makes no mark-read call');
document.querySelector('.pwa-notification-item').click(); await pause();
check(state.readCalls === 1, 'notification click marks read once');
check(bellNavigations.length === 1 && bellNavigations[0] === '/patient/reminders', 'notification routes correctly');
check(!document.querySelector('.pwa-notification-badge'), 'read badge clears');
check(!document.querySelector('#patient-notification-panel'), 'notification click closes panel');
closed('after notification click');
window.profileMenuResult = {assertions, failures};`;

const result = await build({
  root,
  configFile: false,
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "profile-menu-regression-fixture",
    enforce: "pre",
    resolveId(id) {
      if (id.endsWith("profile-menu-test.jsx")) return "\0profile-menu-test.jsx";
      if (id === "profile-test-component") return "\0profile-test-component.jsx";
      if (id === "profile-test-supabase" || /\/supabaseClient(?:\.js)?$/.test(id)) return "\0profile-test-supabase.js";
    },
    load(id) {
      if (id === "\0profile-menu-test.jsx") return fixture;
      if (id === "\0profile-test-component.jsx") return profileSource;
      if (id === "\0profile-test-supabase.js") return mockSource;
    },
  }, react()],
  build: { write: false, minify: true, lib: { entry: "profile-menu-test.jsx", formats: ["es"] } },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
const code = outputs.find(output => output.type === "chunk").code.replaceAll("</script", "<\\/script");
const css = (await Promise.all([
  "patient-PWA.css", "patient-notifications.css", "patient-pwa-ui-system.css",
].map(name => readFile(join(root, "src/styles", name), "utf8")))).join("\n")
  .replace(/@import[^;]+;/g, "");
const temporary = await mkdtemp(join(tmpdir(), "patient-profile-menu-"));
const html = join(temporary, "fixture.html");
await writeFile(html, `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${code}</script>`);

const candidates = process.env.HEADLESS_BROWSER ? [process.env.HEADLESS_BROWSER] : [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch { /* Try the next installed browser. */ }
}
assert.ok(executable, "Set HEADLESS_BROWSER to an installed Chrome/Chromium executable");
const browser = spawn(executable, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-gpu-sandbox",
  "--disable-software-rasterizer", "--disable-extensions", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-port=0",
  `--user-data-dir=${join(temporary, "browser-profile")}`, "about:blank",
], { windowsHide: true, stdio: "ignore" });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket;
let cdp;
try {
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = (await readFile(join(temporary, "browser-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await pause(); }
  }
  assert.ok(port, "Temporary headless browser must start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`Browser command timed out: ${method}`));
    }, 5000).unref();
  });
  let total = 0;
  let failed = 0;
  for (const width of [320, 390, 1366]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: pathToFileURL(html).href });
    let observation;
    for (let attempt = 0; attempt < 100 && !observation; attempt++) {
      await pause();
      const evaluated = await cdp("Runtime.evaluate", { expression: "window.profileMenuResult", returnByValue: true });
      observation = evaluated.result.value;
    }
    assert.ok(observation, "Browser fixture must complete");
    total += observation.assertions;
    failed += observation.failures.length;
    console.log(`${width}px: ${observation.assertions} assertions, ${observation.failures.length} failures`);
    observation.failures.forEach(failure => console.error(`  ${failure}`));
  }
  console.log(`Total: ${total} assertions, ${failed} failures`);
  assert.equal(failed, 0, "Patient profile-menu regression checks must pass");
} finally {
  if (cdp) await cdp("Browser.close").catch(() => browser.kill());
  else browser.kill();
  socket?.close();
}
