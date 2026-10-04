import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { dashboardSectionState, positionDashboardMenu } from "../src/lib/doctorDashboardPresentation.js";
import {
  appointmentStatuses,
  classifyAppointment,
  compareUpcomingAppointments,
  normalizeAppointmentStatus,
} from "../src/lib/appointmentDate.js";
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
const root = new URL("../", import.meta.url);
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function hookRuntime() {
  const slots = [];
  let cursor = 0, dirty = true, render, tree;
  const effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, n) => Object.is(value, b[n]));
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[n].value, update => {
        slots[n].value = typeof update === "function" ? update(slots[n].value) : update;
        dirty = true;
      }];
    },
    useRef(value) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: { current: value } };
      return slots[n].value;
    },
    useCallback(callback, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) slots[n] = { value: callback, deps };
      return slots[n].value;
    },
    useMemo(factory, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) slots[n] = { value: factory(), deps };
      return slots[n].value;
    },
    useEffect(effect, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) {
        effects.push(() => {
          slots[n]?.cleanup?.();
          slots[n] = { deps, cleanup: effect() };
        });
      }
    },
  };
  return {
    react,
    mount(component) { render = component; dirty = true; },
    current() {
      if (dirty) {
        dirty = false; cursor = 0; tree = render();
        for (const effect of effects.splice(0)) effect();
      }
      return tree;
    },
    async settle() {
      for (let n = 0; n < 30; n++) {
        this.current(); await flush();
        if (!dirty) return tree;
      }
      throw Error("Login state did not settle");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat().flatMap(child => nodes(child, predicate))];
}


const jsx = (type, props, key) => ({ type, props: props || {}, key });
async function load(source, name, imports, browserGlobals = {}) {
  const context = vm.createContext({ console, window: { requestAnimationFrame: callback => callback() }, document: { querySelector: () => null }, ...browserGlobals });
  const code = (await transformWithOxc(source, name, { jsx: { runtime: "automatic", development: false } })).code;
  const module = new vm.SourceTextModule(code, { context, initializeImportMeta: meta => { meta.env = {DEV:false}; } });
  await module.link(spec => {
    assert.ok(Object.hasOwn(imports, spec), "Unexpected import: " + spec);
    const exports = imports[spec];
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await module.evaluate(); return module.namespace;
}

const source = await readFile(new URL("src/pages/doctor/Doctor_Dashboard.jsx", root), "utf8");
const styles = await readFile(new URL("src/styles/doctor-dashboard.css", root), "utf8");
const homeSource = 'import {useState,useCallback} from "react"; import {Icon} from "icon"; import ProfileAvatarContent from "avatar"; import DashboardSessionActions from "menu";\n'
  + source.slice(source.indexOf("const dashboardStatusCards"), source.indexOf("const medicalRecordTabParamByLabel"))
  + source.slice(source.indexOf("function DashboardHome"), source.indexOf("function Doctor_Dashboard")).replace("function DashboardHome", "export default function DashboardHome");
const avatarSource = await readFile(new URL("src/components/common/ProfileAvatarContent.jsx", root), "utf8");
const avatar = await load(avatarSource, "Avatar.jsx", { react: React, "react/jsx-runtime": jsxRuntime });
const home = await load(homeSource, "DashboardHome.jsx", {
  react: React, "react/jsx-runtime": jsxRuntime, icon: { Icon: () => null },
  avatar: avatar, menu: { default: ({children}) => React.createElement("div", null, children) },
});
const base = {setActivePage: () => {}, dashboardStats: { totalPatients: 4, todaysAppointments: 1, completedSessions: 3 }, upcomingSessions: [], accountName: "Synthetic Doctor", dashboardMessage: "", dashboardStatsLoading: false};
const render = props => renderToStaticMarkup(React.createElement(home.default, {...base, ...props}));
const loading = render({sessionsState:"loading", dashboardStatsLoading:true});
check(loading.includes("Loading upcoming sessions...") && !loading.includes("No upcoming sessions."), "initial load never flashes empty state");
check(loading.includes("Loading dashboard statistics..."), "accessible statistics loading announcement preserved");
const empty = render({sessionsState:"empty"});
check(empty.includes("No upcoming sessions.") && !empty.includes("doctor-sessions-table"), "successful empty state uses compact balanced presentation");
const failed = render({sessionsState:"error", dashboardStatsUnavailable:true, dashboardMessage:"Unable to refresh the dashboard. Please try again later."});
check(!failed.includes("doctor-loading-bar"), "failed first load stops shimmering");
check(failed.includes("Unavailable") && !failed.includes("No upcoming sessions."), "failure does not present zero totals or success-empty");
check(!failed.includes("Supabase") && !failed.includes("RPC"), "failure presentation contains no internal details");
for (const [input, expected] of [[{hasData:false,failed:false},"loading"],[{hasData:false,failed:true},"error"],[{hasData:true,failed:true,count:1},"data"],[{hasData:true,failed:false,count:0},"empty"],[{hasData:true,failed:true,count:0},"empty"]]) {
  check(dashboardSectionState(input)===expected, "loading/error/cache state: " + expected);
}
const session = n => ({id:String(n), appointmentId:"MA-VERY-LONG-APPOINTMENT-IDENTIFIER-"+n, patient:"Synthetic Patient With A Very Long Name "+n, initials:"SP", patientId:"synthetic", date:"Oct 04",time:"10:30 AM",avatarClass:"avatar-pink",avatarUrl:""});
for (const count of [1,4]) {
  const html=render({sessionsState:"data",upcomingSessions:Array.from({length:count},(_,n)=>session(n))});
  check((html.match(/View Appointment/g)||[]).length===count, count+" appointment actions render");
  check((html.match(/View Patient/g)||[]).length===count, count+" patient actions render");
  check(html.includes("MA-VERY-LONG") && html.includes("Very Long Name"), "long identifiers and names preserved");
  check(html.includes("10:30 AM"), "time text preserved");
  check(html.includes('role="region"') && html.includes('tabindex="0"'), "scrolling region labeled and keyboard focusable");
}
const scoped = styles.slice(styles.indexOf("/* Batch 2:"));
check(scoped.includes("min-width: 900px") && scoped.includes("overflow: auto"), "table remains readable with contained horizontal scrolling");
check(scoped.includes("overflow-wrap: anywhere") && scoped.includes("white-space: normal"), "names and appointment IDs wrap safely");
check(scoped.includes(":nth-child(4) { width: 16%; }") && scoped.includes("width: max-content"), "time column and pill retain readable widths");
check(scoped.includes("padding: 12px 16px"), "responsive padding reduced");
check(scoped.includes("min-height: 0"), "empty card no longer retains oversized minimum height");
check(scoped.split("\n").filter(line=>line.startsWith(".doctor-")).every(line=>line.includes("doctor-dashboard-home--responsive")||line.startsWith(".doctor-dashboard-session-menu")), "all new styles isolated from Staff");
check(styles.includes("repeat(auto-fit, minmax(min(100%, 280px), 1fr))"), "Batch 1 statistics grid preserved");
const rect={top:200,bottom:234,right:500};
const size={width:176,height:96};
const down=positionDashboardMenu(rect,size,{width:768,height:700});
check(down.direction==="down" && down.top===241 && down.left===324, "menu opens below and aligns with trigger when room exists");
const up=positionDashboardMenu({...rect,top:650,bottom:684},size,{width:768,height:700});
check(up.direction==="up" && up.top===547, "menu opens upward near viewport bottom");
for(const width of [375,768,1180]) {
 const pos=positionDashboardMenu({top:40,bottom:74,right:width+30},size,{width,height:130});
 check(pos.left>=8 && pos.left+pos.width<=width-8, "menu clamped horizontally at "+width);
 check(pos.top+Math.min(size.height,pos.maxHeight)<=122, "menu height constrained to viewport at "+width);
}
const avatarRuntime=hookRuntime();
const avatarMock=await load(avatarSource,"Avatar.jsx",{react:avatarRuntime.react,"react/jsx-runtime":{jsx,jsxs:jsx}});
let avatarUrl="broken-url";
avatarRuntime.mount(()=>avatarMock.default({src:avatarUrl,fallback:"SP"}));
check(avatarRuntime.current().type==="img", "avatar initially attempts supplied URL");
avatarRuntime.current().props.onError();
check(avatarRuntime.current()==="SP", "broken avatar falls back to initials");
avatarUrl="new-url"; avatarRuntime.mount(()=>avatarMock.default({src:avatarUrl,fallback:"SP"}));
check(avatarRuntime.current().props.src==="new-url", "replacement avatar URL can render");
const menuSource=await readFile(new URL("src/components/doctor/DashboardSessionActions.jsx",root),"utf8");
const runtime=hookRuntime();
const events=new Map(); const frames=[]; const portalHost={}; let focused=0; let menuFocused=0; let open=false;
const trigger={ getBoundingClientRect:()=>rect, contains:target=>target===trigger, focus:()=>focused++ };
const firstButton={focus:()=>{menuFocused++;documentMock.activeElement=firstButton;}};
const secondButton={focus:()=>{documentMock.activeElement=secondButton;}};
const menuElement={scrollHeight:94,contains:target=>target===menuElement || target===firstButton || target===secondButton,querySelector:()=>firstButton,querySelectorAll:()=>[firstButton,secondButton]};
const windowMock={innerWidth:768,innerHeight:700,requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame:()=>{},addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
const documentMock={body:portalHost,activeElement:menuElement,addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
let portalCount=0;
const menuModule=await load(menuSource,"DashboardSessionActions.jsx",{react:runtime.react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-dom":{createPortal:(node,host)=>{check(host===portalHost,"menu portals to body beyond clipped card");portalCount++;return node;}},"@iconify/react":{Icon:()=>null},"../../lib/doctorDashboardPresentation":{positionDashboardMenu}},{window:windowMock,document:documentMock});
const close=()=>{open=false;runtime.mount(renderMenu);};
function renderMenu(){return menuModule.default({patient:"Synthetic",open,onClose:close,onToggle:()=>{open=!open;runtime.mount(renderMenu);},children:jsx("button",{role:"menuitem"})});}
runtime.mount(renderMenu);
let tree=runtime.current(); nodes(tree,n=>n.type==="button")[0].props.ref.current=trigger;
nodes(tree,n=>n.type==="button")[0].props.onClick();
tree=runtime.current(); nodes(tree,n=>n.props.role==="menu")[0].props.ref.current=menuElement;
for(const frame of frames.splice(0)) frame(); runtime.current();
check(portalCount>0 && menuFocused===1,"opening menu focuses its first action");
events.get("keydown")({key:"Tab",shiftKey:false});
check(open,"Tab between menu actions keeps menu open");
events.get("keydown")({key:"ArrowDown",preventDefault:()=>{}});
check(documentMock.activeElement===secondButton,"ArrowDown reaches second action");
events.get("keydown")({key:"ArrowUp",preventDefault:()=>{}});
check(documentMock.activeElement===firstButton,"ArrowUp returns to first action");
events.get("keydown")({key:"Escape",preventDefault:()=>{}}); runtime.current();
check(!open && focused===1,"Escape closes menu and restores trigger focus");
nodes(runtime.current(),n=>n.type==="button")[0].props.onClick();runtime.current();
events.get("pointerdown")({target:{}});runtime.current();
check(!open && focused===1,"outside interaction closes without stealing external focus");
check(!events.has("pointerdown"),"closed menu removes global listeners");

// Exercise the production loader itself, including returned errors and rejected requests.
const loaderBody=source.slice(source.indexOf("  const loadDashboardStats = useCallback(async () => {"),source.indexOf("  }, [authenticatedDoctorId]);")+"  }, [authenticatedDoctorId]);".length).replace("  const loadDashboardStats = useCallback(async () => {","export async function loadDashboardStats() {").replace("  }, [authenticatedDoctorId]);","}");
const loaderSource='import {supabase} from "db"; import {classifyAppointment,compareUpcomingAppointments,normalizeAppointmentStatus,appointmentStatuses,fetchDashboardPatientAvatarMap,mapUpcomingSession} from "dependencies";\n'
 + 'const authenticatedDoctorId="synthetic"; const dashboardStatsRequestRef={current:0}; export const observed={}; const doctorDashboardSnapshots={set:(id,value)=>observed.snapshot=value}; const setDashboardStats=value=>observed.stats=value; const setDashboardStatsResolved=value=>observed.statsResolved=value; const setDashboardFailed=value=>observed.failed=value; const setDashboardMessage=value=>observed.message=value; const setUpcomingSessions=value=>observed.sessions=value; const setSessionsResolved=value=>observed.sessionsResolved=value;\n'+loaderBody;
let results={patients:{count:4,error:null},schedule:{data:[{id:"synthetic"}],error:null}};
let reject=false;
function query(which){const builder={}; for(const method of ["select","ilike","eq","order"]) builder[method]=()=>builder; builder.then=(resolve,rejectFn)=>reject?Promise.reject(new Error("INTERNAL RPC SECRET")).then(resolve,rejectFn):Promise.resolve(results[which]).then(resolve,rejectFn);return builder;}
const loader=await load(loaderSource,"loader.js",{db:{supabase:{rpc:()=>query("patients"),from:()=>query("schedule")}},dependencies:{classifyAppointment:()=>({isToday:true,isActionable:true,isUpcoming:true}),compareUpcomingAppointments:()=>0,normalizeAppointmentStatus:()=>"scheduled",appointmentStatuses:{completed:"completed"},fetchDashboardPatientAvatarMap:async()=>new Map(),mapUpcomingSession:row=>row}});
results={patients:{error:{message:"INTERNAL RPC SECRET"}},schedule:{error:{message:"INTERNAL DATABASE URL"}}};
await loader.loadDashboardStats();
check(loader.observed.failed===true,"returned query errors mark load failed");
check(!loader.observed.statsResolved && !loader.observed.sessionsResolved,"failed initial request does not claim successfully loaded content");
check(!/INTERNAL|RPC|DATABASE/.test(loader.observed.message),"loader normalizes returned internal errors");
reject=true; await loader.loadDashboardStats();
check(loader.observed.failed===true && !loader.observed.message.includes("SECRET"),"rejected fetch is handled with friendly error");
reject=false; results={patients:{count:4,error:null},schedule:{data:[{id:"synthetic"}],error:null}};
await loader.loadDashboardStats();
check(loader.observed.statsResolved && loader.observed.sessionsResolved && !loader.observed.failed,"later successful request recovers without reload");
check(loader.observed.snapshot.upcomingSessions.length===1,"successful loader preserves existing snapshot behavior");
const cachedStats=loader.observed.stats;const cachedSessions=loader.observed.sessions;
reject=true; await loader.loadDashboardStats();
check(loader.observed.stats===cachedStats && loader.observed.sessions===cachedSessions,"failed refresh leaves valid content untouched");
check(dashboardSectionState({hasData:loader.observed.sessionsResolved,failed:loader.observed.failed,count:loader.observed.sessions.length})==="data","valid content remains visible after failed refresh");

// Compare the actual loader with its prior calculations using the real shared helpers.
// Only the test clock is fixed; production classification/status/date rules are reused.
function priorDashboardResults(rows, now, totalPatients) {
  let classificationCount = 0;
  const classify = row => { classificationCount++; return classifyAppointment(row, now); };
  const today = rows.filter(row => classify(row).isToday);
  const actionableToday = today.filter(row => classify(row).isActionable);
  const completed = rows.filter(row => normalizeAppointmentStatus(row.status) === appointmentStatuses.completed).length;
  const completedToday = today.filter(row => normalizeAppointmentStatus(row.status) === appointmentStatuses.completed).length;
  return {
    stats: {
      totalPatients,
      todaysAppointments: actionableToday.length,
      completedSessions: completed,
      completionProgress: today.length ? Math.min(100, Math.round(completedToday / today.length * 100)) : 0,
    },
    upcomingRows: rows.filter(row => classify(row).isUpcoming).sort(compareUpcomingAppointments).slice(0, 4),
    classificationCount,
    todayCount: today.length,
  };
}

let refreshTime = "2026-10-04T12:00:00+08:00";
let clockCaptures = 0;
class DashboardTestDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [refreshTime]));
    if (!args.length) clockCaptures++;
  }
}
let classificationCalls = [];
let avatarRows = [];
const realLoader = await load(loaderSource, "classification-loader.js", {
  db: { supabase: { rpc: () => query("patients"), from: () => query("schedule") } },
  dependencies: {
    appointmentStatuses, normalizeAppointmentStatus, compareUpcomingAppointments,
    classifyAppointment: (row, now) => {
      classificationCalls.push({ row, now });
      return classifyAppointment(row, now);
    },
    fetchDashboardPatientAvatarMap: async rows => { avatarRows = rows; return new Map(); },
    mapUpcomingSession: row => row,
  },
}, { Date: DashboardTestDate });

async function compareRefresh(label, rows, time = refreshTime, totalPatients = 17) {
  refreshTime = time;
  classificationCalls = [];
  avatarRows = [];
  clockCaptures = 0;
  reject = false;
  results = { patients: { count: totalPatients, error: null }, schedule: { data: rows, error: null } };
  const before = JSON.stringify(rows);
  const prior = priorDashboardResults(rows, new Date(time), totalPatients);
  await realLoader.loadDashboardStats();
  assert.deepEqual(JSON.parse(JSON.stringify(realLoader.observed.stats)), prior.stats); checks++;
  assert.deepEqual(Array.from(realLoader.observed.sessions), prior.upcomingRows); checks++;
  assert.deepEqual(classificationCalls.map(call => call.row), rows); checks++;
  check(clockCaptures === 1, label + ": reference time captured once per refresh");
  check(classificationCalls.every(call => call.now === classificationCalls[0].now && call.now.getTime() === Date.parse(time)), label + ": every row uses the same current reference time");
  check(prior.classificationCount === rows.length * 2 + prior.todayCount, label + ": prior calls were two per row plus one per today's row");
  assert.deepEqual(Array.from(avatarRows), prior.upcomingRows); checks++;
  check(avatarRows.every(row => rows.includes(row)), label + ": avatar lookup receives original schedule rows");
  check(JSON.stringify(rows) === before, label + ": schedule input is not mutated");
  check(!realLoader.observed.failed && realLoader.observed.statsResolved && realLoader.observed.sessionsResolved, label + ": successful loading flags preserved");
  assert.deepEqual(JSON.parse(JSON.stringify(realLoader.observed.snapshot)), {
    dashboardStats: prior.stats, upcomingSessions: prior.upcomingRows,
  }); checks++;
  return { stats: realLoader.observed.stats, sessions: Array.from(realLoader.observed.sessions), calls: classificationCalls };
}

const appointment = (id, status, start, end = start) => ({ id, status, start_time: start, end_time: end });
const fixtures = [
  appointment("future-later", "accepted", "2026-10-04T14:00:00+08:00"),
  appointment("cancelled", "cancelled", "2026-10-04T13:00:00+08:00"),
  appointment("current", "pending", "2026-10-04T11:45:00+08:00", "2026-10-04T12:15:00+08:00"),
  appointment("missed", "missed", "2026-10-04T13:00:00+08:00"),
  appointment("overdue", "scheduled", "2026-10-04T10:00:00+08:00", "2026-10-04T10:30:00+08:00"),
  appointment("completed", "completed", "2026-10-04T09:00:00+08:00"),
  appointment("historic-completed", " done ", "2026-09-01T09:00:00+08:00"),
  appointment("no-show", "no-show", "2026-10-04T13:00:00+08:00"),
  appointment("overdue-checked-in", "checked-in", "2026-10-04T09:00:00+08:00"),
  appointment("current-checked-in", "check_in", "2026-10-04T11:00:00+08:00", "2026-10-04T12:30:00+08:00"),
  appointment("future-earlier", "scheduled", "2026-10-04T13:00:00+08:00"),
  appointment("next-day", "scheduled", "2026-10-05T00:05:00+08:00"),
  appointment("start-boundary", "scheduled", "2026-10-04T12:00:00+08:00", "2026-10-04T12:30:00+08:00"),
  appointment("end-boundary", "scheduled", "2026-10-04T11:00:00+08:00", "2026-10-04T12:00:00+08:00"),
  appointment("cancel-alias", "canceled", "2026-10-04T13:00:00+08:00"),
  appointment("invalid", "scheduled", "invalid"),
  appointment("no-start", "scheduled", null),
  { id: "no-end", status: "scheduled", start_time: "2026-10-04T15:00:00+08:00" },
  appointment("invalid-completed", "complete", "invalid"),
  appointment("future-tied", "scheduled", "2026-10-04T13:00:00+08:00"),
];
const midday = await compareRefresh("mixed same-day statuses", fixtures);
assert.deepEqual(JSON.parse(JSON.stringify(midday.stats)), {
  totalPatients: 17, todaysAppointments: 8, completedSessions: 3, completionProgress: 7,
}); checks++;
assert.deepEqual(midday.sessions.map(row => row.id), ["current-checked-in", "end-boundary", "current", "start-boundary"]); checks++;
check(!midday.sessions.some(row => ["cancelled", "cancel-alias", "missed", "no-show", "completed", "overdue", "overdue-checked-in"].includes(row.id)), "terminal and overdue rows stay excluded from upcoming sessions");
const afterCurrent = await compareRefresh("current becomes overdue", fixtures, "2026-10-04T12:30:00.001+08:00");
check(!afterCurrent.sessions.some(row => ["current", "current-checked-in", "start-boundary", "end-boundary"].includes(row.id)), "elapsed sessions retain existing overdue/checked-in handling");
check(midday.calls[0].now !== afterCurrent.calls[0].now && midday.calls[0].now.getTime() < afterCurrent.calls[0].now.getTime(), "each refresh captures a fresh timestamp, never a global stale time");
await compareRefresh("stable ordering for equal start times", fixtures.slice().reverse(), "2026-10-04T12:30:00.001+08:00");
const noRows = await compareRefresh("empty schedule", [], "2026-10-04T12:00:00+08:00", 0);
assert.deepEqual(JSON.parse(JSON.stringify(noRows.stats)), { totalPatients: 0, todaysAppointments: 0, completedSessions: 0, completionProgress: 0 }); checks++;
check(noRows.sessions.length === 0, "empty schedule retains empty upcoming sessions");
for (const row of fixtures) await compareRefresh("single row: " + row.id, [row], "2026-10-04T12:00:00+08:00");

const midnightRows = [
  appointment("previous-day-current", "scheduled", "2026-10-03T23:59:00+08:00", "2026-10-04T00:01:00+08:00"),
  appointment("midnight-start", "scheduled", "2026-10-03T16:00:00Z", "2026-10-03T16:10:00Z"),
  appointment("previous-day-completed", "completed", "2026-10-03T15:59:59Z"),
  appointment("new-day-completed", "done", "2026-10-03T16:00:00Z"),
  appointment("just-after-midnight", "scheduled", "2026-10-04T00:00:00.001+08:00"),
];
for (const time of ["2026-10-03T23:59:59.999+08:00", "2026-10-04T00:00:00+08:00", "2026-10-04T00:00:00.001+08:00"]) {
  const boundary = await compareRefresh("Manila midnight: " + time, midnightRows, time);
  check(boundary.stats.todaysAppointments === (time.startsWith("2026-10-03") ? 1 : 2), "Manila day transition preserves active-today count");
  check(boundary.stats.completedSessions === 2, "Manila day transition preserves all-time completed count");
  check(boundary.stats.completionProgress === (time.startsWith("2026-10-03") ? 50 : 33), "Manila day transition preserves completion denominator");
}
const largeRows = Array.from({ length: 2000 }, (_, index) => ({ ...fixtures[index % fixtures.length], id: "large-" + index }));
await compareRefresh("large 2,000-row schedule", largeRows, "2026-10-04T12:00:00+08:00");

// Exercise the production coordinator with deferred promises, without timing sleeps.
let concurrencyChecks = 0;
const concurrencyCheck = (ok, message) => { check(ok, message); concurrencyChecks++; };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const coordinatorSource = source.slice(source.indexOf("function createDashboardRefreshCoordinator()"), source.indexOf("const navItems"))
  .replace("function createDashboardRefreshCoordinator()", "export function createDashboardRefreshCoordinator()");
const { createDashboardRefreshCoordinator } = await load(coordinatorSource, "refresh-coordinator.js", {});
function coordinatorProbe() {
  const calls = [];
  let running = 0, maxRunning = 0;
  return {
    calls,
    get running() { return running; },
    get maxRunning() { return maxRunning; },
    loader(label = "doctor-a") {
      return () => {
        const work = deferred();
        calls.push({ ...work, label });
        maxRunning = Math.max(maxRunning, ++running);
        return work.promise.finally(() => { running--; });
      };
    },
  };
}
{
  const coordinator = createDashboardRefreshCoordinator(), probe = coordinatorProbe();
  const scope = coordinator.activate(probe.loader());
  const work = scope.request();
  await flush();
  concurrencyCheck(probe.calls.length === 1 && probe.running === 1, "one request starts one loader");
  const queued = Array.from({ length: 5 }, () => scope.request());
  await flush();
  concurrencyCheck(probe.calls.length === 1 && probe.maxRunning === 1, "five triggers never overlap the current loader");
  concurrencyCheck(queued.every(promise => promise === work), "queued callers share the current drain promise");
  probe.calls[0].resolve(); await flush();
  concurrencyCheck(probe.calls.length === 2 && probe.running === 1, "five triggers cause exactly one trailing refresh");
  for (let index = 0; index < 5; index++) scope.request();
  await flush();
  concurrencyCheck(probe.calls.length === 2, "triggers during trailing work remain coalesced");
  probe.calls[1].resolve(); await flush();
  concurrencyCheck(probe.calls.length === 3, "trailing work can queue one additional trailing refresh");
  probe.calls[2].resolve(); await work; await flush();
  concurrencyCheck(probe.calls.length === 3 && probe.running === 0 && probe.maxRunning === 1, "drain stops without queued work and concurrency never exceeds one");
  const next = scope.request(); await flush();
  concurrencyCheck(probe.calls.length === 4, "a later idle request can start normally");
  probe.calls[3].resolve(); await next; await flush();
  concurrencyCheck(probe.calls.length === 4, "no queued trigger means no trailing refresh");
  scope.stop();
}
for (const queued of [false, true]) {
  const coordinator = createDashboardRefreshCoordinator(), probe = coordinatorProbe();
  const scope = coordinator.activate(probe.loader());
  const work = scope.request(); await flush();
  if (queued) for (let index = 0; index < 5; index++) scope.request();
  probe.calls[0].reject(new Error("Synthetic request failure")); await flush();
  concurrencyCheck(probe.calls.length === (queued ? 2 : 1), "rejection runs a trailing refresh only when requested");
  if (queued) probe.calls[1].resolve();
  await work; await flush();
  concurrencyCheck(probe.running === 0 && probe.maxRunning === 1, "failure releases the in-flight lock");
  concurrencyCheck(probe.calls.length === (queued ? 2 : 1), "failure never creates an automatic retry loop");
  const next = scope.request(); await flush();
  concurrencyCheck(probe.calls.length === (queued ? 3 : 2), "an explicit request still works after failure");
  probe.calls.at(-1).resolve(); await next; scope.stop();
}
{
  const coordinator = createDashboardRefreshCoordinator();
  let calls = 0, scope;
  scope = coordinator.activate(() => {
    calls++;
    if (calls === 1) scope.request();
    throw new Error("Synthetic synchronous failure");
  });
  await scope.request(); await flush();
  concurrencyCheck(calls === 2, "lock is installed before synchronous triggers and exceptions");
  scope.stop();
}
{
  const coordinator = createDashboardRefreshCoordinator(), probe = coordinatorProbe();
  const scope = coordinator.activate(probe.loader());
  const work = scope.request(); scope.stop(); await work;
  concurrencyCheck(probe.calls.length === 0, "cleanup before loader startup prevents all work");
  concurrencyCheck(scope.request() === undefined, "inactive callbacks cannot revive a stopped scope");
}
for (const reason of ["section leave", "unmount", "logout", "session loss"]) {
  const coordinator = createDashboardRefreshCoordinator(), probe = coordinatorProbe();
  const scope = coordinator.activate(probe.loader());
  const work = scope.request(); await flush(); scope.request(); scope.stop();
  concurrencyCheck(scope.request() === undefined, reason + ": stale trigger ignored");
  probe.calls[0].resolve(); await work; await flush();
  concurrencyCheck(probe.calls.length === 1 && probe.running === 0, reason + ": queued trailing work discarded");
}
{
  const coordinator = createDashboardRefreshCoordinator(), probe = coordinatorProbe();
  const oldScope = coordinator.activate(probe.loader("doctor-a"));
  const oldWork = oldScope.request(); await flush(); oldScope.request(); oldScope.stop();
  const newScope = coordinator.activate(probe.loader("doctor-b"));
  await flush();
  concurrencyCheck(probe.calls.length === 1, "new Doctor never inherits the old pending flag");
  const newWork = newScope.request(); oldScope.stop();
  concurrencyCheck(oldScope.request() === undefined, "old Doctor callbacks cannot request new Doctor work");
  await flush();
  concurrencyCheck(probe.calls.length === 1, "new scope waits for old HTTP work instead of overlapping it");
  probe.calls[0].resolve(); await flush();
  concurrencyCheck(probe.calls.length === 2 && probe.calls[1].label === "doctor-b", "only the newly requested Doctor refresh runs next");
  probe.calls[1].resolve(); await Promise.all([oldWork, newWork]);
  concurrencyCheck(probe.maxRunning === 1 && probe.calls.length === 2, "old cleanup cannot clear the new scope or cause duplicate work");
  newScope.stop();
}

// Execute the actual refresh effect with fake timers and captured Realtime callbacks.
const refreshEffect = source.slice(source.indexOf('  useEffect(() => {\n    if (activePage !== "dashboard"'), source.indexOf("  const openMedicalRecordTarget"));
const effectBody = refreshEffect.slice("  useEffect(() => {".length, refreshEffect.lastIndexOf("  }, ["));
const effectProbe = coordinatorProbe(), timeoutCallbacks = new Map(), intervalCallbacks = new Map(), focusCallbacks = new Map(), realtimeCallbacks = new Map();
const removedChannels = [];
let timerId = 0;
const channel = {
  on(event, filter, callback) { realtimeCallbacks.set(filter.table, { event, filter, callback }); return this; },
  subscribe() { return this; },
};
const effectModule = await load('import {loadDashboardStats,supabase,createDashboardRefreshCoordinator} from "dependencies";\n'
  + 'const activePage="dashboard", authenticatedDoctorId="synthetic"; const dashboardStatsRequestRef={current:0}; const dashboardRefreshCoordinatorRef={current:null};\n'
  + "export function mountRefreshEffect() {" + effectBody + "}\nexport function requestRevision() { return dashboardStatsRequestRef.current; }", "refresh-effect.js", {
  dependencies: {
    loadDashboardStats: effectProbe.loader(), createDashboardRefreshCoordinator,
    supabase: { channel: name => { concurrencyCheck(name === "doctor-dashboard-synthetic", "Realtime channel name preserved"); return channel; }, removeChannel: value => removedChannels.push(value) },
  },
}, { window: {
  setTimeout: (callback, delay) => { concurrencyCheck(delay === 0, "initial zero-delay refresh preserved"); timeoutCallbacks.set(++timerId, callback); return timerId; },
  clearTimeout: id => timeoutCallbacks.delete(id),
  setInterval: (callback, delay) => { concurrencyCheck(delay === 60_000, "60-second refresh cadence preserved"); intervalCallbacks.set(++timerId, callback); return timerId; },
  clearInterval: id => intervalCallbacks.delete(id),
  addEventListener: (name, callback) => focusCallbacks.set(name, callback),
  removeEventListener: (name, callback) => { if (focusCallbacks.get(name) === callback) focusCallbacks.delete(name); },
} });
const stopEffect = effectModule.mountRefreshEffect();
concurrencyCheck(realtimeCallbacks.get("patients").filter.event === "*" && realtimeCallbacks.get("patients").filter.schema === "public", "Patient Realtime definition preserved");
concurrencyCheck(realtimeCallbacks.get("schedule").filter.filter === "doctor_id=eq.synthetic", "Doctor-specific Schedule Realtime filter preserved");
const triggers = [timeoutCallbacks.values().next().value, focusCallbacks.get("focus"), intervalCallbacks.values().next().value,
  realtimeCallbacks.get("patients").callback, realtimeCallbacks.get("schedule").callback];
for (const [index, trigger] of triggers.entries()) {
  const work = trigger(); await flush();
  concurrencyCheck(effectProbe.calls.length === index + 1, "existing refresh trigger " + index + " starts an idle refresh");
  effectProbe.calls[index].resolve(); await work;
}
const realtimeWork = realtimeCallbacks.get("patients").callback(); await flush();
for (let index = 0; index < 5; index++) {
  realtimeCallbacks.get("patients").callback(); realtimeCallbacks.get("schedule").callback();
}
await flush();
concurrencyCheck(effectProbe.calls.length === 6, "simultaneous Patient/Schedule events do not overlap");
effectProbe.calls[5].resolve(); await flush();
concurrencyCheck(effectProbe.calls.length === 7, "simultaneous Realtime events cause one trailing refresh");
focusCallbacks.get("focus")(); stopEffect();
effectProbe.calls[6].resolve(); await realtimeWork;
concurrencyCheck(effectProbe.calls.length === 7 && effectProbe.maxRunning === 1, "effect cleanup discards the trailing flag");
concurrencyCheck(effectModule.requestRevision() === 1, "existing stale-response revision is invalidated on cleanup");
concurrencyCheck(timeoutCallbacks.size === 0 && intervalCallbacks.size === 0 && focusCallbacks.size === 0, "timer/focus cleanup preserved");
concurrencyCheck(removedChannels.length === 1 && removedChannels[0] === channel, "Realtime channel cleanup preserved");
for (const trigger of triggers) concurrencyCheck(trigger() === undefined, "captured callbacks cannot revive the cleaned-up Dashboard");

// Keep the full loader locked through avatar completion and check real state/snapshot behavior.
async function productionRefreshHarness() {
  const batches = [], avatars = [];
  function builder(promise) {
    const query = { then: (yes, no) => promise.then(yes, no) };
    for (const method of ["select", "ilike", "eq", "order"]) query[method] = () => query;
    return query;
  }
  const harnessSource = loaderSource.replace('const authenticatedDoctorId="synthetic"', 'let authenticatedDoctorId="synthetic"')
    + '\nexport function invalidateDoctor(id) { authenticatedDoctorId=id; dashboardStatsRequestRef.current++; }';
  const module = await load(harnessSource, "coalesced-loader.js", {
    db: { supabase: {
      rpc: () => { const batch = deferred(); batches.push(batch); return builder(batch.promise.then(result => result.patients)); },
      from: () => builder(batches.at(-1).promise.then(result => result.schedule)),
    } },
    dependencies: {
      appointmentStatuses, normalizeAppointmentStatus, compareUpcomingAppointments, classifyAppointment,
      fetchDashboardPatientAvatarMap: async rows => { const work = deferred(); avatars.push({ ...work, rows }); return work.promise; },
      mapUpcomingSession: row => row,
    },
  }, { Date: DashboardTestDate });
  return { module, batches, avatars };
}
const goodRefresh = count => ({ patients: { count, error: null }, schedule: { data: fixtures, error: null } });
{
  const harness = await productionRefreshHarness(), coordinator = createDashboardRefreshCoordinator();
  const scope = coordinator.activate(harness.module.loadDashboardStats);
  const work = scope.request(); await flush();
  concurrencyCheck(harness.batches.length === 1 && !harness.module.observed.statsResolved && !harness.module.observed.sessionsResolved, "initial load retains unresolved presentation");
  for (let index = 0; index < 5; index++) scope.request();
  harness.batches[0].resolve(goodRefresh(17)); await flush();
  concurrencyCheck(harness.batches.length === 1 && harness.avatars.length === 1, "lock covers the avatar stage of the full loader");
  concurrencyCheck(harness.module.observed.statsResolved && !harness.module.observed.sessionsResolved, "existing metrics-before-avatar loading behavior retained");
  harness.avatars[0].resolve(new Map()); await flush();
  const currentStats = harness.module.observed.stats, currentSessions = harness.module.observed.sessions, currentSnapshot = harness.module.observed.snapshot;
  concurrencyCheck(harness.batches.length === 2 && Boolean(currentSnapshot), "trailing work starts only after sessions and snapshot commit");
  concurrencyCheck(harness.module.observed.statsResolved && harness.module.observed.sessionsResolved, "background trailing refresh keeps resolved content");
  scope.request();
  harness.batches[1].resolve({ patients: { error: { message: "Synthetic count error" } }, schedule: { error: { message: "Synthetic schedule error" } } });
  await flush();
  concurrencyCheck(harness.batches.length === 3 && harness.module.observed.failed, "friendly loader failure still permits requested trailing work");
  concurrencyCheck(harness.module.observed.stats === currentStats && harness.module.observed.sessions === currentSessions && harness.module.observed.snapshot === currentSnapshot, "failure preserves current/cached content");
  concurrencyCheck(harness.module.observed.message === "Unable to refresh the dashboard. Please try again later.", "existing friendly error message preserved");
  harness.batches[2].resolve(goodRefresh(23)); await flush(); harness.avatars[1].resolve(new Map()); await work;
  const expected = priorDashboardResults(fixtures, new Date(refreshTime), 23);
  concurrencyCheck(JSON.stringify(harness.module.observed.stats) === JSON.stringify(expected.stats), "queued successful refresh preserves exact metrics");
  concurrencyCheck(JSON.stringify(harness.module.observed.sessions) === JSON.stringify(expected.upcomingRows), "queued successful refresh preserves upcoming order");
  concurrencyCheck(!harness.module.observed.failed && harness.batches.length === 3, "successful trailing recovery stops without automatic retries");
  scope.stop();
}
for (const stage of ["primary queries", "avatar lookup"]) {
  const harness = await productionRefreshHarness(), coordinator = createDashboardRefreshCoordinator();
  const scope = coordinator.activate(harness.module.loadDashboardStats);
  const work = scope.request(); await flush(); scope.request();
  if (stage === "avatar lookup") { harness.batches[0].resolve(goodRefresh(17)); await flush(); }
  scope.stop(); harness.module.invalidateDoctor("");
  if (stage === "avatar lookup") harness.avatars[0].resolve(new Map());
  else harness.batches[0].resolve(goodRefresh(17));
  await work; await flush();
  concurrencyCheck(harness.batches.length === 1 && !harness.module.observed.sessionsResolved && !harness.module.observed.snapshot, stage + ": session loss prevents stale session/snapshot commits and trailing work");
  if (stage === "primary queries") concurrencyCheck(!harness.module.observed.statsResolved && harness.avatars.length === 0, "session loss also prevents stale metrics and avatar work");
}
{
  const harness = await productionRefreshHarness(), coordinator = createDashboardRefreshCoordinator();
  const oldScope = coordinator.activate(harness.module.loadDashboardStats);
  const work = oldScope.request(); await flush(); oldScope.request(); oldScope.stop();
  harness.module.invalidateDoctor("doctor-b");
  const newScope = coordinator.activate(harness.module.loadDashboardStats); newScope.request();
  harness.batches[0].resolve(goodRefresh(99)); await flush();
  concurrencyCheck(harness.batches.length === 2 && !harness.module.observed.statsResolved && harness.avatars.length === 0, "Doctor change discards old response before metrics/avatar processing");
  harness.batches[1].resolve(goodRefresh(23)); await flush(); harness.avatars[0].resolve(new Map()); await work;
  concurrencyCheck(harness.module.observed.stats.totalPatients === 23 && harness.batches.length === 2, "only the new Doctor response populates the Dashboard");
  newScope.stop();
}


const homeRuntime=hookRuntime();
const interactiveHome=await load(homeSource,"DashboardHome.jsx",{react:homeRuntime.react,"react/jsx-runtime":{jsx,jsxs:jsx,Fragment:"fragment"},icon:{Icon:()=>null},avatar:avatar,menu:{default:()=>null}});
let destination=null;
homeRuntime.mount(()=>interactiveHome.default({...base,sessionsState:"data",upcomingSessions:[session(1)],setActivePage:(page,options)=>{destination={page,options};}}));
const actions=nodes(homeRuntime.current(),node=>node.props.role==="menuitem");
actions[0].props.onClick();
check(destination.page==="appointments" && destination.options.path==="/doctor/appointments?appointmentId="+encodeURIComponent(session(1).appointmentId),"View Appointment preserves encoded appointment destination");
actions[1].props.onClick();
check(destination.page==="patients" && destination.options.path==="/doctor/patients/synthetic","View Patient preserves destination");
const changed=spawnSync("git",["diff","--name-only"],{cwd:new URL("../",import.meta.url),encoding:"utf8",windowsHide:true});
check(changed.status===0 && !/AppointmentVisitForm|StaffPreConsultationForm|src\/pages\/staff/.test(changed.stdout),"shared visit forms and Staff pages remain untouched");

console.log("Doctor Dashboard regression: "+checks+" assertions passed, including "+concurrencyChecks+" deterministic concurrency assertions.");
