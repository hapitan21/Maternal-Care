// Real Profile helpers/hooks/JSX and installed SDK; synthetic Auth/HTTP only.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import process from "node:process";
import * as vm from "node:vm";
import {createClient} from "@supabase/supabase-js";
import {transformWithOxc} from "vite";
import postcss from "postcss";
import * as summary from "../src/lib/doctorProfileSummary.js";
import * as role from "../src/lib/roleInactivity.js";
import * as authorization from "../src/lib/doctorRouteAuthorization.js";
import * as status from "../src/lib/clinicAccountStatus.js";
if(!vm.SourceTextModule){const run=spawnSync(process.execPath,["--experimental-vm-modules",...process.argv.slice(1)],{stdio:"inherit",windowsHide:true});if(run.error)throw run.error;process.exit(run.status??1);}
const root=new URL("../",import.meta.url);
const source=async path=>(await readFile(new URL(path,root),"utf8")).replace(/\r\n/g,"\n");
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const equal=(a,b,label)=>{assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),label);checks++;};
const loadingAnnouncement=view=>nodes(view).find(node=>node.props.children==="Loading appointment summary...");
const accessibleLoading=view=>{const announcement=loadingAnnouncement(view);return announcement?.props.className==="app-sr-only"&&announcement.props.role==="status"&&!announcement.props.hidden&&!announcement.props["aria-hidden"];};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const now="2026-10-31T16:01:00Z";
const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const row=(n,status="scheduled",time="2026-11-01T00:00:00+08:00",doctor="doctor-a")=>({id:uuid(n),doctor_id:doctor,start_time:time,status});
const session=(id="doctor-a",sid="session-a")=>({user:{id,email:id+"@example.test"},access_token:"x."+Buffer.from(JSON.stringify({session_id:sid})).toString("base64url")+".x",refresh_token:"synthetic",expires_at:Math.floor(Date.now()/1000)+3600});
const identity=(id="doctor-a")=>({authUser:session(id).user,profile:{id,role:"doctor",account_status:"active"},doctorDisplayName:id,personalInformation:null,professionalInformation:null});
function splitExpressions(value){let depth=0,start=0;const parts=[];for(let n=0;n<value.length;n++){if(value[n]==="(")depth++;if(value[n]===")")depth--;if(value[n]===","&&depth===0){parts.push(value.slice(start,n));start=n+1;}}parts.push(value.slice(start));return parts;}
function matches(expression,item){
 const group=/^(and|or)\((.*)\)$/.exec(expression);
 if(group){const parts=splitExpressions(group[2]).map(part=>matches(part,item));return group[1]==="and"?parts.every(Boolean):parts.some(Boolean);}
 const atom=/^(\w+)\.(eq|gt|is)\.(.*)$/.exec(expression);assert.ok(atom,"Unsupported PostgREST filter: "+expression);
 const [,field,operator,wanted]=atom,value=item[field];
 if(operator==="is")return wanted==="null"&&value==null;if(value==null)return false;
 const a=field==="start_time"?Date.parse(value):String(value),b=field==="start_time"?Date.parse(wanted):wanted;
 return operator==="eq"?a===b:a>b;
}
function database(rows=[],cap=500){
 const calls=[],listeners=new Set(),channels=[],removed=[],windowListeners=new Map(),documentListeners=new Map();
 const env={rows,cap,calls,listeners,channels,removed,identityQueries:[],current:session(),beforePage:null,transformPage:null,failAt:0,sessionGate:null,
  window:{addEventListener(name,fn){if(!windowListeners.has(name))windowListeners.set(name,new Set());windowListeners.get(name).add(fn);},removeEventListener(name,fn){windowListeners.get(name)?.delete(fn);},emit(name){for(const fn of [...windowListeners.get(name)||[]])fn();}},windowListeners,
  document:{visibilityState:"visible",addEventListener(name,fn){if(!documentListeners.has(name))documentListeners.set(name,new Set());documentListeners.get(name).add(fn);},removeEventListener(name,fn){documentListeners.get(name)?.delete(fn);},emit(name){for(const fn of [...documentListeners.get(name)||[]])fn();}},documentListeners};
 env.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:input);
  check(url.pathname==="/rest/v1/schedule","Only the existing schedule table is queried");
  check(url.searchParams.get("select")==="id,doctor_id,start_time,status","Profile query selects only summary/ownership fields");
  check(url.searchParams.get("order")==="start_time.asc.nullslast,id.asc","Stable timestamp/unique-ID ordering with nulls last");
  check(url.searchParams.get("limit")==="500","Every page request has a bounded size");
  check(["eq.doctor-a","eq.doctor-b"].includes(url.searchParams.get("doctor_id")),"Every page retains an explicit Doctor scope");
  const call={url,ordinal:calls.length+1,token:new Headers(options.headers).get("Authorization")};calls.push(call);
  let page=env.rows.filter(item=>Array.from(url.searchParams).every(([field,value])=>["select","order","limit"].includes(field)?true:field==="or"?matches("or"+value,item):matches(field+"."+value,item)));
  page.sort((a,b)=>{if(a.start_time==null&&b.start_time!=null)return 1;if(b.start_time==null&&a.start_time!=null)return -1;return (Date.parse(a.start_time||"")-Date.parse(b.start_time||""))||a.id.localeCompare(b.id);});
  page=page.slice(0,Math.min(env.cap,500));
  await env.beforePage?.(call);
  if(call.ordinal===env.failAt)return new Response(JSON.stringify({message:"Synthetic failed page",code:"XX000"}),{status:500});
  if(env.transformPage)page=env.transformPage(call,page);call.size=page?.length??null;
  return new Response(JSON.stringify(page),{status:200,headers:{"Content-Type":"application/json"}});
 };
 env.client={supabaseUrl:"https://profile.example.test",supabaseKey:"synthetic-public",auth:{
  async getUser(){return {data:{user:env.current?.user||null},error:null};},
  async getSession(){const captured=env.current;if(env.sessionGate)await env.sessionGate.promise;if(env.sessionFailure)throw Error("Synthetic rejected session");return {data:{session:captured},error:null};},
  onAuthStateChange(fn){listeners.add(fn);return {data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}};}},
  from(table){
   const query={select(){return query;},eq(column,id){env.identityQueries.push({table,column,id});query.id=id;return query;},async maybeSingle(){
    check(["profiles","doctor_personal_information","doctor_professional_information"].includes(table),"Identity integration queries only existing Doctor identity tables");
    return {data:table==="profiles"?{id:query.id,role:"doctor",account_status:"active",full_name:"Synthetic Doctor"}:null,error:null};
   }};return query;
  },
  channel(name){const entry={name};channels.push(entry);const channel={on(event,filter,fn){entry.filter=filter;entry.refresh=fn;return channel;},subscribe(){return channel;}};return channel;},removeChannel(channel){removed.push(channel);return Promise.resolve();}};
 env.emit=(event,next)=>{env.current=next;for(const fn of [...listeners])fn(event,next);};
 env.factory=(url,key,options)=>createClient(url,key,{...options,global:{fetch:env.fetch}});
 env.sdk=createClient(env.client.supabaseUrl,env.client.supabaseKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:env.fetch}});
 return env;
}
// Independent SDK pagination cases, including a server cap smaller than 500.
for(const [count,cap] of [[0,500],[500,500],[1507,500],[1003,127]]){
 const own=Array.from({length:count},(_,n)=>row(n+1)),env=database([...own,row(99999,"completed",undefined,"doctor-b")],cap);
 const rows=await summary.fetchDoctorProfileAppointments(env.sdk,"doctor-a");
 equal(rows.map(item=>item.id),own.map(item=>item.id),"All same-timestamp IDs survive pagination: "+count+" / "+cap);
 check(env.calls.at(-1).size===0,"Only an empty final page confirms complete totals");
 equal(summary.summarizeDoctorProfileAppointments(rows,"this-month",new Date(now)),{cancelled:0,pending:count,completed:0,today:count},"Counts include complete scoped data, without Doctor B");
}
{
 const env=database([row(1),row(2),row(3,"completed",null),row(4,"scheduled",null)],2);
 env.transformPage=(call,page)=>call.ordinal===1?[...page,page.at(-1)]:call.ordinal===2?[row(1),...page]:page;
 const rows=await summary.fetchDoctorProfileAppointments(env.sdk,"doctor-a");equal(rows.map(item=>item.id),[1,2,3,4].map(uuid),"Repeated IDs within/across pages never inflate totals; null timestamp cursor completes");
 equal(summary.summarizeDoctorProfileAppointments(rows,"all-time",new Date(now)),{cancelled:0,pending:3,completed:1,today:2},"All-time null dates retain stored statuses without adding to today");
}
for(const failure of ["error","null","id","owner","cursor"]){
 const env=database([row(1),row(2),row(3)],2);
 if(failure==="error")env.failAt=2;
 else env.transformPage=(call,page)=>failure==="null"?null:failure==="id"?[{...row(1),id:null}]:failure==="owner"?[row(1,"scheduled",undefined,"doctor-b")]:call.ordinal===2?[row(1),row(2)]:page;
 await assert.rejects(()=>summary.fetchDoctorProfileAppointments(env.sdk,"doctor-a"));checks++;
}
{
 const env=database();await assert.rejects(()=>summary.fetchDoctorProfileAppointments(env.sdk,""));checks++;check(env.calls.length===0,"Missing Doctor ID never sends an unscoped request");
 equal(await summary.fetchDoctorProfileAppointments(env.sdk,"doctor-a",()=>false),null,"Already stale load has no result and sends no pages");
}
// Clinic calendar invariance across browser/system time zones, with half-open bounds.
const previousTZ=process.env.TZ;
try{for(const tz of ["UTC","America/Los_Angeles","Asia/Manila","Pacific/Kiritimati"]){process.env.TZ=tz;
 equal(summary.getDoctorProfileSummaryRange("this-month",new Date(now)),{start:Date.parse("2026-10-31T16:00:00Z"),end:Date.parse("2026-11-30T16:00:00Z")},"Manila November boundary independent of browser zone: "+tz);
 equal(summary.getDoctorProfileSummaryRange("last-month",new Date(now)),{start:Date.parse("2026-09-30T16:00:00Z"),end:Date.parse("2026-10-31T16:00:00Z")},"Manila October boundary independent of browser zone: "+tz);
 const rows=[row(1,"cancelled","2026-10-31T15:59:59.999Z"),row(2,"canceled","2026-10-31T16:00:00Z"),row(3,"pending","2026-11-30T15:59:59.999Z"),row(4,"completed","2026-11-30T16:00:00Z"),row(5,"checked_in"),row(6,"missed"),row(7,"done"),row(8,"accepted"),row(9,"unexpected")];
 equal(summary.summarizeDoctorProfileAppointments(rows,"this-month",new Date(now)),{cancelled:1,pending:2,completed:1,today:6},"Inclusive start, exclusive end; status aliases preserved; today includes all statuses: "+tz);
 equal(summary.summarizeDoctorProfileAppointments(rows,"last-month",new Date(now)),{cancelled:1,pending:0,completed:0,today:6},"Today's card ignores selected month: "+tz);
}
 equal(summary.getDoctorProfileSummaryRange("last-month",new Date("2027-01-01T00:01:00+08:00")),{start:Date.parse("2026-11-30T16:00:00Z"),end:Date.parse("2026-12-31T16:00:00Z")},"January rolls back into previous year's December");
 equal(summary.getDoctorProfileSummaryRange("this-month",new Date("2024-02-29T23:59:00+08:00")),{start:Date.parse("2024-01-31T16:00:00Z"),end:Date.parse("2024-02-29T16:00:00Z")},"Leap-year February uses actual Manila month end");
}finally{if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;}
const regression=await source("scripts/verify-doctor-dashboard-batch2.mjs");
const hooksRuntime=new Function(regression.slice(regression.indexOf("function hooksRuntime()"),regression.indexOf("const element")).replace("    unmount() {", "    remount() { this.unmount(); slots.length=0; effects.length=0; dirty=true; this.flush(); },\n    unmount() {")+";return hooksRuntime;")();
const settle=async hooks=>{for(let n=0;n<4;n++){await new Promise(resolve=>setImmediate(resolve));hooks?.flush();}};
const element=(type,props)=>({type,props:props||{}}),jsx={jsx:element,jsxs:element,Fragment:"Fragment"};
const nodes=node=>!node||typeof node!=="object"?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)];
async function evaluate(code,name,mocks,context){code=code.replace(/import.meta.env/g,"({DEV:false})");if(name.endsWith(".jsx"))code=(await transformWithOxc(code,name,{jsx:{runtime:"automatic"}})).code;const module=new vm.SourceTextModule(code,{context,identifier:name});await module.link(specifier=>{const values=specifier.endsWith(".css")?{}:mocks[specifier];if(!values)throw Error("Unmocked import: "+specifier);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});});await module.evaluate();return module.namespace;}
async function harness(configure=()=>{},renderProfile=false,initialIdentity=identity(),withIdentity=false){
 const env=database();configure(env);const hooks=hooksRuntime();
 const context=vm.createContext({console,window:env.window,document:env.document,AbortController,atob,setTimeout,clearTimeout,Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return Date.parse(now);}}});
 const security=await evaluate(await source("src/lib/authenticatedMutation.js"),"scope.js",{"@supabase/supabase-js":{createClient:env.factory},"./roleInactivity":role},context);
 const hook=await evaluate(await source("src/hooks/useDoctorProfileSummary.js"),"summary-hook.js",{react:hooks.runtime,"../lib/supabaseClient":{supabase:env.client},"../lib/authenticatedMutation":security,"../lib/roleInactivity":role,"../lib/doctorRouteAuthorization.js":authorization,"../lib/doctorProfileSummary.js":summary},context);
 const navigations=[],commits=[];
 const doctorHook=withIdentity?await evaluate(await source("src/hooks/useAuthenticatedDoctor.js"),"doctor-identity.js",{react:hooks.runtime,"../lib/supabaseClient":{supabase:env.client},"../lib/clinicAccountStatus":status,"../lib/profilePicture":{getProfilePictureDisplayUrl:async()=>"",profilePictureUpdatedEvent:"avatar-updated"}},context):null;
 if(renderProfile){const profile=await evaluate(await source("src/pages/doctor/Doctor_ViewProfile.jsx"),"profile.jsx",{react:hooks.runtime,"react/jsx-runtime":jsx,"react-router-dom":{useNavigate:()=>path=>navigations.push(path)},"@iconify/react":{Icon:"Icon"},"../../components/common/ProfilePictureActions":{default:"PhotoActions"},"../../components/common/ProfileAvatarContent":{default:"Avatar"},"../../hooks/useDoctorProfileSummary":hook,"../../lib/clinicAccountStatus":status},context);hooks.mount(withIdentity?()=>profile.default({doctorIdentity:doctorHook.useAuthenticatedDoctor()}):profile.default,{doctorIdentity:initialIdentity},result=>commits.push(result));}
 else hooks.mount(props=>hook.useDoctorProfileSummary(props.doctorIdentity,props.period),{doctorIdentity:initialIdentity,period:"this-month"});
 if(withIdentity)env.emit("INITIAL_SESSION",env.current);
 return {...env,hooks,env,navigations,commits,identity:initialIdentity};
}
{
 const h=await harness();check(h.hooks.result.status==="loading"&&h.hooks.result.summary===null,"Initial pending hook cannot publish zero counts");await settle(h.hooks);
 equal(h.hooks.result.summary,summary.emptyDoctorProfileSummary,"Successful empty data yields legitimate zeros");check(h.hooks.result.status==="ready"&&!h.hooks.result.error,"Valid zero has ready status rather than unavailable");
 check(h.channels[0].filter.filter==="doctor_id=eq.doctor-a","Realtime subscription retains authenticated Doctor scope");h.hooks.unmount();
 check(h.listeners.size===0&&[...h.windowListeners.values()].every(set=>set.size===0)&&[...h.documentListeners.values()].every(set=>set.size===0)&&h.removed.length===1,"Unmount removes Auth, focus, visibility and realtime subscriptions");
}
{
 const h=await harness(env=>{env.rows=[row(1),row(2)];});await settle(h.hooks);const prior={...h.hooks.result.summary};
 h.env.rows=[row(1),row(2),row(3)];h.env.cap=2;h.env.failAt=h.calls.length+2;h.window.emit("focus");h.hooks.flush();
 check(h.hooks.result.status==="refreshing","Background refresh is distinct from initial loading");equal(h.hooks.result.summary,prior,"Pending refresh retains verified same-session and same-period counts");await settle(h.hooks);
 equal(h.hooks.result.summary,prior,"Later-page failure publishes no partial totals and preserves verified prior summary");check(h.hooks.result.status==="error"&&h.hooks.result.error.includes("last successful"),"Failed refresh explicitly labels retained counts as stale");
 h.env.failAt=0;h.hooks.result.retry();h.hooks.flush();await settle(h.hooks);check(h.hooks.result.status==="ready"&&h.hooks.result.summary.pending===3&&!h.hooks.result.error,"Retry resolves a failed page and clears feedback");h.hooks.unmount();
}
{
 const first=deferred(),second=deferred();const h=await harness(env=>{env.rows=[row(1)];env.failAt=1;env.beforePage=call=>call.ordinal===1?first.promise:call.ordinal===2?second.promise:undefined;});await settle(h.hooks);
 h.env.rows=[row(1),row(2)];h.channels[0].refresh();await settle(h.hooks);second.resolve();await settle(h.hooks);
 check(h.hooks.result.status==="ready"&&h.hooks.result.summary.pending===2,"Newer realtime response publishes its complete summary");const writes=h.hooks.stateWrites;first.resolve();await settle(h.hooks);
 check(h.hooks.result.summary.pending===2&&h.hooks.stateWrites===writes,"Late earlier failed response cannot overwrite counts, clear state, or report a stale error");h.hooks.unmount();
}
{
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1)];env.beforePage=call=>call.ordinal===1?gate.promise:undefined;});await settle(h.hooks);
 h.hooks.update({doctorIdentity:h.identity,period:"last-month"});await settle(h.hooks);check(h.hooks.result.summary.pending===0&&h.hooks.result.summary.today===1,"New period preserves today definition and resets monthly counts");gate.resolve();await settle(h.hooks);check(h.hooks.result.summary.pending===0,"Late old period cannot restore its counts");h.hooks.unmount();
}
for(const transition of ["logout","replacement","same-user-replacement","unmount"]){
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1),row(2,"completed",undefined,"doctor-b")];env.beforePage=call=>call.ordinal===1?gate.promise:undefined;});await settle(h.hooks);
 const priorCalls=h.calls.length;
 if(transition==="same-user-replacement")h.env.sessionGate=deferred();
 if(transition==="unmount")h.hooks.unmount();else{h.env.emit(transition==="logout"?"SIGNED_OUT":"SIGNED_IN",transition==="logout"?null:session(transition==="replacement"?"doctor-b":"doctor-a","replacement"));h.hooks.flush();check(["unavailable","loading"].includes(h.hooks.result.status)&&h.hooks.result.summary===null,"Session transition immediately clears counts: "+transition);}
 const writes=h.hooks.stateWrites;gate.resolve();await settle(transition==="unmount"?null:h.hooks);
 check(h.hooks.stateWrites===writes&&h.calls.length===priorCalls,"Late request cannot publish or continue paging after "+transition);
 check(h.calls[0].token==="Bearer "+session().access_token,"SDK page retained initiating A's token: "+transition);
 if(transition==="replacement"){const next=identity("doctor-b");h.hooks.update({doctorIdentity:next,period:"this-month"});await settle(h.hooks);check(h.hooks.result.status==="ready"&&h.hooks.result.summary.completed===1&&h.hooks.result.summary.pending===0,"Fresh Doctor B identity loads only B's summary");}
 if(transition!=="unmount")h.hooks.unmount();h.env.sessionGate?.resolve();await settle();check(h.listeners.size===0,"Session lifecycle cleans up all captured Auth scopes: "+transition);
}
for(const kind of ["inactive","wrong-role","mismatch","error","loading","missing"]){
 const doctor=identity();if(kind==="inactive")doctor.profile.account_status="inactive";if(kind==="wrong-role")doctor.profile.role="staff";if(kind==="mismatch")doctor.profile.id="doctor-b";if(kind==="error")doctor.error=Error("Identity unavailable");if(kind==="loading")doctor.loading=true;if(kind==="missing")doctor.authUser=null;
 const h=await harness(()=>{},false,doctor);await settle(h.hooks);check(h.calls.length===0&&h.hooks.result.status==="unavailable"&&h.hooks.result.summary===null,"Unauthorized/unresolved identity sends no summary queries: "+kind);h.hooks.unmount();
}
{
 const h=await harness(env=>{env.sessionFailure=true;});await settle(h.hooks);check(h.hooks.result.status==="error"&&h.hooks.result.summary===null&&h.calls.length===0,"Rejected session lookup ends loading without a zero or unscoped query");
 h.env.sessionFailure=false;h.hooks.result.retry();h.hooks.flush();await settle(h.hooks);check(h.hooks.result.status==="ready","Session lookup failure is retryable");h.hooks.unmount();
}
{
 const h=await harness(env=>{env.failAt=1;},true);const cards=()=>nodes(h.hooks.result).filter(node=>node.props.className==="doctor-profile-summary-card");
 check(cards().every(card=>nodes(card).some(node=>node.type==="strong"&&node.props.children==="\u2026")),"Rendered initial Profile shows loading placeholders");
 check(accessibleLoading(h.hooks.result),"Initial loading announcement remains accessible while using the visually hidden utility");
 check(!nodes(h.hooks.result).some(node=>node.props.className==="doctor-profile-summary-message"),"Initial loading adds no visible message row or layout spacing");await settle(h.hooks);
 check(cards().every(card=>nodes(card).some(node=>node.type==="strong"&&node.props.children==="\u2014")),"Rendered failed initial load shows unavailable rather than zero");
 const alert=nodes(h.hooks.result).find(node=>node.props.className==="doctor-profile-summary-message is-error");check(alert.props.role==="alert","Summary error is visible and announced");
 h.env.failAt=0;nodes(alert).find(node=>node.type==="button").props.onClick();h.hooks.flush();await settle(h.hooks);
 check(cards().every(card=>nodes(card).some(node=>node.type==="strong"&&node.props.children===0)),"Rendered retry distinguishes legitimate empty data with zero counts");
 for(const card of cards())card.props.onClick();equal(h.navigations,["/doctor/appointments?status=cancelled","/doctor/appointments?scope=today","/doctor/appointments?status=pending","/doctor/appointments?status=completed"],"Summary navigation labels/routes remain unchanged");h.hooks.unmount();
}
{
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1)];env.beforePage=call=>call.ordinal===1?gate.promise:undefined;});await settle(h.hooks);
 h.env.emit("TOKEN_REFRESHED",session());h.hooks.flush();
 check(h.hooks.result.status==="loading","Same logical session token refresh does not invalidate its pending summary");
 gate.resolve();await settle(h.hooks);check(h.hooks.result.status==="ready"&&h.hooks.result.summary.pending===1,"Token-refresh response remains valid for the same Doctor/session");
 h.env.rows=[row(1),row(2,"completed")];h.channels[0].refresh();h.hooks.flush();await settle(h.hooks);
 check(h.hooks.result.summary.completed===1&&h.hooks.result.summary.today===2,"Existing Doctor-scoped realtime callback refreshes the complete summary");h.hooks.unmount();
}
{
 const gate=deferred();const h=await harness(env=>{env.sessionGate=gate;});await settle(h.hooks);
 check(h.calls.length===0&&h.hooks.result.status==="loading","Initial session capture pending cannot send a summary query");h.hooks.unmount();
 check(h.listeners.size===0,"Unmount removes even an initializing captured-session subscription");const writes=h.hooks.stateWrites;gate.resolve();await settle();
 check(h.hooks.stateWrites===writes&&h.calls.length===0,"Late initial session capture cannot query or publish after unmount");
}
{
 const gate=deferred();const h=await harness(env=>{env.sessionGate=gate;});await settle(h.hooks);h.env.emit("SIGNED_IN",session("doctor-b","replacement"));h.hooks.flush();
 check(h.hooks.result.status==="unavailable"&&h.hooks.result.summary===null,"Replacement during initial capture immediately clears the summary");gate.resolve();await settle(h.hooks);
 check(h.calls.length===0,"Late A capture cannot send any query under replacement B");h.hooks.unmount();
}
{
 const h=await harness(env=>{env.rows=[row(1)];},true);await settle(h.hooks);
 h.env.rows=[row(1),row(2)];h.env.cap=1;h.env.failAt=h.calls.length+2;h.window.emit("focus");await settle(h.hooks);
 const alert=nodes(h.hooks.result).find(node=>node.props.className==="doctor-profile-summary-message is-error");
 check(alert?.props.role==="alert"&&nodes(alert).some(node=>node.type==="span"&&node.props.children.includes("last successful")),"Rendered failed page visibly marks prior counts as stale");
 check(typeof nodes(alert).find(node=>node.type==="button"&&node.props.children==="Retry")?.props.onClick==="function","Rendered failed refresh retains a working Retry control alongside stale counts");
 const counts=nodes(h.hooks.result).filter(node=>node.props.className==="doctor-profile-summary-card").map(card=>nodes(card).find(node=>node.type==="strong").props.children);
 equal(counts,[0,1,1,0],"Rendered partial failure retains full prior counts instead of partial or zero totals");
 const select=nodes(h.hooks.result).find(node=>node.type==="select");select.props.onChange({target:{value:"last-month"}});h.hooks.flush();
 check(nodes(h.hooks.result).filter(node=>node.props.className==="doctor-profile-summary-card").every(card=>nodes(card).some(node=>node.type==="strong"&&node.props.children==="\u2026")),"Rendered period change immediately replaces prior counts with loading placeholders");h.hooks.unmount();
}
{
 const h=await harness();await settle(h.hooks);const queuedAuth=[...h.listeners][0],queuedFocus=[...h.windowListeners.get("focus")][0],queuedRealtime=h.channels[0].refresh,queuedVisibility=[...h.documentListeners.get("visibilitychange")][0];
 h.hooks.unmount();const writes=h.hooks.stateWrites,calls=h.calls.length;
 queuedAuth("SIGNED_OUT",null);queuedFocus();queuedRealtime();queuedVisibility();await settle();
 check(h.hooks.stateWrites===writes&&h.calls.length===calls,"Retained queued Auth/focus/visibility/realtime callbacks cannot publish or query after unmount");
}
{
 const h=await harness(env=>{env.rows=[row(1)];});await settle(h.hooks);check(h.hooks.result.summary.pending===1,"Verified prior summary is established before a silent session change");
 h.env.failAt=h.calls.length+1;h.env.beforePage=()=>{h.env.current=session("doctor-b","replacement");};h.window.emit("focus");await settle(h.hooks);
 check(h.hooks.result.status==="unavailable"&&h.hooks.result.summary===null,"Failed HTTP page cannot mask replacement or expose even stale A counts under B");h.hooks.unmount();
}
// Background refresh keeps verified counts; focus/visibility bursts share one load.
{
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1,"cancelled"),row(2),row(3,"completed")];});await settle(h.hooks);
 const prior=h.hooks.result.summary,initialCalls=h.calls.length;
 h.document.visibilityState="hidden";h.document.emit("visibilitychange");await settle(h.hooks);
 check(h.calls.length===initialCalls&&h.hooks.result.status==="ready","Hidden visibility change does not start a refresh");
 h.env.beforePage=call=>call.ordinal===initialCalls+1?gate.promise:undefined;
 h.window.emit("focus");h.hooks.flush();
 check(h.hooks.result.status==="refreshing"&&h.hooks.result.summary===prior&&!h.hooks.result.error,"Tab-focus refresh immediately retains all known counts without an initial loading state");
 await settle(h.hooks);const calls=h.calls.length,writes=h.hooks.stateWrites;
 h.document.visibilityState="visible";h.document.emit("visibilitychange");h.window.emit("focus");h.window.emit("focus");await settle(h.hooks);
 check(h.calls.length===calls&&h.hooks.stateWrites===writes,"Overlapping focus and visible events do not restart or duplicate the pending refresh");
 gate.resolve();await settle(h.hooks);
 check(h.hooks.result.status==="ready"&&h.hooks.result.summary===prior,"Equal verified results retain the exact previous summary object");
 h.env.rows=[row(1,"cancelled"),row(2),row(3,"completed"),row(4)];h.document.emit("visibilitychange");h.hooks.flush();
 check(h.hooks.result.status==="refreshing"&&h.hooks.result.summary===prior,"Standalone visible event also retains same-period counts");await settle(h.hooks);
 check(h.hooks.result.summary!==prior&&h.hooks.result.summary.pending===2&&h.hooks.result.summary.today===4,"Only changed verified results replace the previous counts");h.hooks.unmount();
}
{
 const gate=deferred();const h=await harness(env=>{env.beforePage=call=>call.ordinal===1?gate.promise:undefined;});await settle(h.hooks);
 const calls=h.calls.length;h.window.emit("focus");h.document.emit("visibilitychange");await settle(h.hooks);
 check(h.hooks.result.status==="loading"&&h.hooks.result.summary===null&&h.calls.length===calls,"Initial load stays pending without fake counts and coalesces redundant focus/visibility events");
 gate.resolve();await settle(h.hooks);const prior=h.hooks.result.summary;
 h.window.emit("focus");h.hooks.flush();check(h.hooks.result.status==="refreshing"&&h.hooks.result.summary===prior&&prior.pending===0,"Legitimate zero counts remain visible during background refresh");
 await settle(h.hooks);check(h.hooks.result.summary===prior,"Unchanged zero summary is not replaced");h.hooks.unmount();
}
{
 const first=deferred(),second=deferred();const h=await harness(env=>{env.rows=[row(1)];});await settle(h.hooks);
 const prior=h.hooks.result.summary,ordinal=h.calls.length+1;
 h.env.beforePage=call=>call.ordinal===ordinal?first.promise:call.ordinal===ordinal+1?second.promise:undefined;
 h.env.rows=[row(1),row(2)];h.window.emit("focus");await settle(h.hooks);
 h.env.rows=[row(1),row(2),row(3)];h.channels[0].refresh();h.hooks.flush();
 check(h.hooks.result.status==="refreshing"&&h.hooks.result.summary===prior,"Realtime superseding a pending focus refresh preserves the known summary");await settle(h.hooks);
 second.resolve();await settle(h.hooks);check(h.hooks.result.summary.pending===3,"Latest realtime invalidation is processed even during a coalesced focus refresh");
 const writes=h.hooks.stateWrites;first.resolve();await settle(h.hooks);
 check(h.hooks.result.summary.pending===3&&h.hooks.stateWrites===writes,"Out-of-order successful background response cannot overwrite newer verified counts");h.hooks.unmount();
}
{
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1)];});await settle(h.hooks);
 const ordinal=h.calls.length+1;h.env.beforePage=call=>call.ordinal===ordinal?gate.promise:undefined;
 h.hooks.update({doctorIdentity:h.identity,period:"last-month"});
 check(h.hooks.result.status==="loading"&&h.hooks.result.summary===null,"Changing period hides the previous successful counts before new results arrive");await settle(h.hooks);
 check(h.hooks.result.summary===null,"A pending new-period request cannot restore the old period's cache");gate.resolve();await settle(h.hooks);
 check(h.hooks.result.status==="ready"&&h.hooks.result.summary.pending===0,"Changed period publishes its own verified counts");h.hooks.unmount();
}
for(const id of ["doctor-b","doctor-a"]){
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1),row(2,"completed",undefined,"doctor-b")];});await settle(h.hooks);
 const ordinal=h.calls.length+1;h.env.beforePage=call=>call.ordinal===ordinal?gate.promise:undefined;
 h.window.emit("focus");await settle(h.hooks);const capture=deferred();if(id==="doctor-a")h.env.sessionGate=capture;h.env.emit("SIGNED_IN",session(id,"replacement"));h.hooks.flush();
 check(["unavailable","loading"].includes(h.hooks.result.status)&&h.hooks.result.summary===null,"Replacement immediately clears previously successful counts, including same-Doctor new sessions: "+id);
 const writes=h.hooks.stateWrites;gate.resolve();await settle(h.hooks);
 check(h.hooks.stateWrites===writes&&h.hooks.result.summary===null,"Late refresh cannot expose the old session's cached counts: "+id);
 h.env.rows=[row(3,"completed",undefined,id)];h.hooks.update({doctorIdentity:identity(id),period:"this-month"});
 check(h.hooks.result.status==="loading"&&h.hooks.result.summary===null,"New authenticated session begins with no reused counts: "+id);h.env.sessionGate=null;capture.resolve();await settle(h.hooks);
 check(h.hooks.result.summary.completed===1&&h.hooks.result.summary.pending===0,"Replacement session reads its own complete summary: "+id);h.hooks.unmount();
}
{
 const gate=deferred();const h=await harness(env=>{env.rows=[row(1,"cancelled"),row(2),row(3,"completed")];},true);await settle(h.hooks);
 const cards=()=>nodes(h.hooks.result).filter(node=>node.props.className==="doctor-profile-summary-card");
 const counts=()=>cards().map(card=>nodes(card).find(node=>node.type==="strong").props.children);
 const ordinal=h.calls.length+1;h.env.beforePage=call=>call.ordinal===ordinal?gate.promise:undefined;
 h.window.emit("focus");h.hooks.flush();equal(counts(),[1,3,1,1],"Rendered tab-focus refresh keeps every known card count");
 check(!nodes(h.hooks.result).some(node=>node.props.children==="Loading appointment summary..."),"Rendered background refresh does not insert the disruptive loading message");
 check(nodes(h.hooks.result).find(node=>node.props.className==="doctor-profile-summary").props["aria-busy"]===true,"Background refresh is exposed accessibly without replacing counts");await settle(h.hooks);
 h.document.emit("visibilitychange");await settle(h.hooks);equal(counts(),[1,3,1,1],"Rendered visible event retains counts during the pending focus request");
 gate.resolve();await settle(h.hooks);check(nodes(h.hooks.result).find(node=>node.props.className==="doctor-profile-summary").props["aria-busy"]===false,"Background busy state clears after success");h.hooks.unmount();
}
// Reproduce visibility-triggered SDK Auth events through the real identity hook.
{
 const h=await harness(env=>{env.rows=[row(1,"cancelled"),row(2),row(3,"completed")];},true,identity(),true);await settle(h.hooks);
 const counts=view=>nodes(view).filter(node=>node.props.className==="doctor-profile-summary-card").map(card=>nodes(card).find(node=>node.type==="strong").props.children);
 equal(counts(h.hooks.result),[1,3,1,1],"Real Doctor identity/Profile integration establishes verified summary counts");
 for(const event of ["SIGNED_IN","SIGNED_IN","TOKEN_REFRESHED","SIGNED_IN"]){
  const beforeCalls=h.calls.length,beforeChannels=h.channels.length;h.commits.length=0;
  h.env.emit(event,session());h.hooks.flush();
  check(h.commits.every(view=>counts(view).length===4&&counts(view).every(value=>typeof value==="number")),"Fresh same-session Auth user references never render summary placeholders: "+event);
  check(h.calls.length===beforeCalls&&h.channels.length===beforeChannels,"Same logical Auth refresh does not restart the summary query/subscription: "+event);await settle(h.hooks);
  check(h.calls.length===beforeCalls,"Auth reference churn alone creates no unnecessary summary requests: "+event);
 }
 for(let n=0;n<5;n++){
  const gate=deferred(),ordinal=h.calls.length+1,channels=h.channels.length;h.env.beforePage=call=>call.ordinal===ordinal?gate.promise:undefined;h.commits.length=0;
  h.document.visibilityState="hidden";h.document.emit("visibilitychange");h.document.visibilityState="visible";h.document.emit("visibilitychange");
  h.env.emit(n%2?"TOKEN_REFRESHED":"SIGNED_IN",session());h.window.emit("focus");h.hooks.flush();await settle(h.hooks);
  check(h.commits.every(view=>counts(view).length===4&&counts(view).every(value=>typeof value==="number")),"Repeated tab-return commits retain all counts during same-session Auth reference churn: "+n);
  check(h.channels.length===channels&&h.calls.length===ordinal,"Visibility/Auth/focus return cycle shares one pending summary load and does not recreate the channel: "+n);
  gate.resolve();await settle(h.hooks);equal(counts(h.hooks.result),[1,3,1,1],"Repeated tab switching keeps correct verified counts: "+n);
  check(h.calls.length===ordinal+1,"Each tab-return completes exactly one two-page retrieval without duplicate cycles: "+n);
 }
 h.env.beforePage=null;const select=nodes(h.hooks.result).find(node=>node.type==="select");select.props.onChange({target:{value:"last-month"}});h.hooks.flush();
 check(counts(h.hooks.result).every(value=>value==="\u2026"),"Integrated period switch shows pending rather than old period counts");await settle(h.hooks);
 equal(counts(h.hooks.result),[0,3,0,0],"Integrated period switch loads correct month counts and preserves today's definition");
 h.env.failAt=h.calls.length+1;h.window.emit("focus");h.env.emit("SIGNED_IN",session());h.hooks.flush();await settle(h.hooks);
 equal(counts(h.hooks.result),[0,3,0,0],"Failed tab-return refresh retains all prior same-session and period counts");
 const alert=nodes(h.hooks.result).find(node=>node.props.className==="doctor-profile-summary-message is-error");
 check(alert?.props.role==="alert"&&nodes(alert).some(node=>node.type==="span"&&node.props.children.includes("last successful")),"Integrated failed refresh visibly identifies stale data");
 h.commits.length=0;h.env.emit("TOKEN_REFRESHED",session());h.hooks.flush();
 check(h.commits.every(view=>counts(view).every(value=>typeof value==="number")),"Same-session Auth refresh also preserves explicitly stale counts");
 h.env.failAt=0;nodes(alert).find(node=>node.type==="button").props.onClick();h.hooks.flush();await settle(h.hooks);
 check(!nodes(h.hooks.result).some(node=>node.props.className==="doctor-profile-summary-message is-error"),"Integrated Retry verifies fresh data and clears stale feedback");
 h.hooks.unmount();check(h.listeners.size===0,"Integrated Doctor identity/Profile cleanup releases all Auth subscriptions");
}
{
 const h=await harness(env=>{env.rows=[row(1)];});await settle(h.hooks);const previous=h.hooks.result.summary;
 h.env.rows=[row(2,"completed")];h.hooks.remount();
 check(h.hooks.result.status==="loading"&&h.hooks.result.summary===null,"A genuine component remount has its own pending state rather than a global Doctor cache");await settle(h.hooks);
 check(h.hooks.result.summary!==previous&&h.hooks.result.summary.completed===1&&h.hooks.result.summary.pending===0,"Same module remounted with fresh hook state independently verifies its counts");
 check(h.channels.length===2&&h.removed.length===1,"Genuine remount recreates its channel, unlike ordinary same-session Auth reference updates");h.hooks.unmount();
}
// Normal loading uses only existing card placeholders and a hidden live status.
{
 const rules=postcss.parse(await source("src/index.css"));const declarations={};
 rules.walkRules(".app-sr-only",rule=>rule.walkDecls(declaration=>{declarations[declaration.prop]=declaration.value;}));
 check(declarations.position==="absolute"&&declarations.width==="1px"&&declarations.height==="1px"&&declarations.overflow==="hidden"&&declarations.clip==="rect(0, 0, 0, 0)","Existing screen-reader utility removes the loading announcement from visible layout (source-level CSS check)");
 check(declarations.display!=="none"&&declarations.visibility!=="hidden","Screen-reader utility does not hide live status from assistive technology");
 const h=await harness(env=>{env.rows=[row(1),row(2,"cancelled","2026-10-15T09:00:00+08:00"),row(3,"completed","2026-10-20T09:00:00+08:00"),row(4,"completed")];},true);await settle(h.hooks);
 const cards=()=>nodes(h.hooks.result).filter(node=>node.props.className==="doctor-profile-summary-card");
 const counts=()=>cards().map(card=>nodes(card).find(node=>node.type==="strong").props.children);
 const structure=()=>cards().map(card=>[card.type,card.props.className,card.props["aria-label"]]);
 const initialStructure=structure();
 equal(counts(),[0,2,1,1],"Initial verified This Month counts are correct");
 for(const [period,expected]of [["last-month",[1,2,0,1]],["all-time",[1,2,1,2]],["this-month",[0,2,1,1]]]){
  const gate=deferred(),ordinal=h.calls.length+1;h.env.beforePage=call=>call.ordinal===ordinal?gate.promise:undefined;
  nodes(h.hooks.result).find(node=>node.type==="select").props.onChange({target:{value:period}});h.hooks.flush();
  equal(structure(),initialStructure,"Period loading preserves the four existing card controls/layout structure: "+period);
  check(counts().length===4&&counts().every(value=>value==="\u2026"),"New period uses subtle placeholders without old-period or false zero counts: "+period);
  check(accessibleLoading(h.hooks.result),"Period loading is announced only through the visually hidden status: "+period);
  check(!nodes(h.hooks.result).some(node=>node.props.className==="doctor-profile-summary-message"),"Period switching adds no visible normal-loading row: "+period);
  await settle(h.hooks);check(counts().every(value=>value==="\u2026"),"Pending authoritative period load cannot expose prior counts: "+period);
  gate.resolve();await settle(h.hooks);equal(counts(),expected,"Selected period publishes its own correct counts: "+period);
  check(!loadingAnnouncement(h.hooks.result),"Loading announcement clears after verified results: "+period);
 }
 h.hooks.unmount();
}
console.log("Doctor Profile summary verification passed: "+checks+" assertions.");
console.log("Production helpers/hooks/JSX and installed SDK verified with synthetic Auth/HTTP; no live Supabase or browser validation.");
