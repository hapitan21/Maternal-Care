/* global process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { dashboardSectionState, positionDashboardMenu } from "../src/lib/doctorDashboardPresentation.js";
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

console.log("Doctor Dashboard Batch 2: "+checks+" assertions passed.");
