import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import * as vm from "node:vm";
import { transformWithOxc } from "vite";
import { createClient } from "@supabase/supabase-js";

if (!vm.SourceTextModule) {
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
const root = new URL("../", import.meta.url);
const source = async path => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const rejects = async (work, code, label) => { await assert.rejects(work, error => error.code === code); checks++; console.log("PASS: " + label); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const session = (id="doctor-a", sid="session-a") => ({ user: { id, email: id+"@example.test", email_confirmed_at: "synthetic" }, access_token: "x."+Buffer.from(JSON.stringify({session_id:sid})).toString("base64url")+".x", refresh_token: "synthetic-refresh", expires_at: Math.floor(Date.now()/1000)+3600 });
const element = (type, props) => ({ type, props: props || {} });
const jsx = { jsx: element, jsxs: element, Fragment: "Fragment" };
const context = vm.createContext({ console, atob, setTimeout, clearTimeout, URL, Event, AbortController, CustomEvent: class { constructor(type,options) {this.type=type;this.detail=options.detail;} } });
async function evaluate(code, filename, mocks, ctx=context) {
  if (filename.endsWith(".jsx")) code = (await transformWithOxc(code, filename, { jsx: { runtime: "automatic" } })).code;
  const module = new vm.SourceTextModule(code, { context:ctx, identifier:filename });
  await module.link(specifier => {
    const values = specifier.endsWith(".css") ? {} : mocks[specifier];
    if (!values) throw Error("Unmocked import " + specifier);
    return new vm.SyntheticModule(Object.keys(values), function() { for (const [key,value] of Object.entries(values)) this.setExport(key,value); }, {context:ctx});
  });
  await module.evaluate(); return module.namespace;
}
const role = await evaluate(await source("src/lib/roleInactivity.js"), "role.js", {});
let factory;
const security = await evaluate(await source("src/lib/authenticatedMutation.js"), "security.js", {
  "@supabase/supabase-js": { createClient: (...args) => factory(...args) }, "./roleInactivity": role,
});
const settingsData = await evaluate(await source("src/lib/doctorSettingsData.js"), "settings-data.js", {});
for (const token of ["", "1", "12345", "1234567", "12a456", "abcdef"]) {
  assert.throws(() => security.requireFullOtp(token), error => error.code === "invalid_otp"); checks++;
}
check(security.requireFullOtp("123456") === "123456", "Only a complete numeric OTP reaches server verification");
function environment() {
  let current = session(); let authoritative = {...current.user};
  const subscribers = new Set(), writes=[], authCalls=[], timers=new Map(), notices=[];
  let timer=0, pendingEmail="", completeOtp=true;
  const env = {
    writes,authCalls,timers,notices,subscribers,
    get current(){return current;}, get authoritative(){return authoritative;},
    set authoritative(user){authoritative=user;},
    get pendingEmail(){return pendingEmail;}, set completeOtp(value){completeOtp=value;},
    emit(event,next) { current=next; if(next)authoritative={...next.user}; for(const fn of [...subscribers])fn(event,next); },
    failure: null, readGate: null, rows: {
      doctor_personal_information: {id:"personal-a",auth_user_id:"doctor-a",full_name:"Doctor A",years_of_experience:null},
      doctor_professional_information: {id:"professional-a",auth_user_id:"doctor-a",doctor_code:"A",contact_number:"original-contact",email_address:"doctor-a@example.test",clinic_hospital_name:"Original Clinic"},
      profiles: {id:"doctor-a",role:"doctor",account_status:"active",full_name:"Doctor A",contact_number:"original-contact",avatar_url:"original-avatar"},
      user_availability: [],
    },
    fail: null, gate: null, writeGate: null, writeGateTable: "", authGate: null, authGateMethod: "", userGate: null,
    window: {
      location:{origin:"https://synthetic.example.test"},
      setTimeout(fn,delay){timers.set(++timer,{fn,delay});return timer;}, clearTimeout(id){timers.delete(id);},
      setInterval(fn,delay){timers.set(++timer,{fn,delay,interval:true});return timer;}, clearInterval(id){timers.delete(id);},
      dispatchEvent(event){notices.push(event);},
    },
    fireTimeouts() {for(const [id,entry] of [...timers])if(!entry.interval){timers.delete(id);entry.fn();}},
  };
  const client = { supabaseUrl:"https://synthetic.supabase.test",supabaseKey:"synthetic-public", auth: {
    async getSession(){return {data:{session:current},error:null};},
    async getUser(){if(env.userGate)await env.userGate.promise;return {data:{user:{...authoritative}},error:null};},
    onAuthStateChange(fn){subscribers.add(fn);return {data:{subscription:{unsubscribe:()=>subscribers.delete(fn)}}};},
  }, storage:{from:()=>({getPublicUrl:path=>({data:{publicUrl:"https://synthetic.example.test/"+path}})})} };
  env.client=client;
  env.factory=(url,key,options)=>{
    check(options.auth.persistSession===false && options.auth.autoRefreshToken===false, "Scoped clients never persist or auto-refresh another account");
    if (options.accessToken) {
      const request = async (table,action,payload,filter) => {
        const token=await options.accessToken();
        const readSnapshot = env.captureAvailabilityRead && table==="user_availability" && action==="select" ? [...env.rows.user_availability] : null;
        if(action!=="select")writes.push({table,action,payload,filter,token});
        if(env.readGate && table==="user_availability" && action==="select")await env.readGate.promise;
        if(env.writeGate && table===env.writeGateTable && action!=="select")await env.writeGate.promise;
        if(env.failure?.table===table && (!env.failure.action || env.failure.action===action)) {
          if(env.failure.kind==="thrown")throw Error("Synthetic rejected query");
          return {data:null,error:{message:"Synthetic returned query error"}};
        }
        if(env.fail)return {data:null,error:env.fail};
        if(action==="upsert"||action==="update"||action==="insert"){
          if(table==="user_availability"){
            env.rows[table]=[...env.rows[table].filter(row=>row.day_of_week!==payload.day_of_week),{...payload}];
            return {data:env.invalidReadback?.table===table?env.invalidReadback.data:{...payload},error:null};
          }
          env.rows[table]={...env.rows[table],...payload};
        }
        if(env.invalidReadback?.table===table)return {data:env.invalidReadback.data,error:null};
        if(table==="sync_current_profile_email"){env.rows.profiles.email=authoritative.email;return {data:authoritative.email,error:null};}
        return {data:action==="select"&&table==="user_availability"?readSnapshot || [...env.rows[table]]:{...env.rows[table]},error:null};
      };
      const db={ from(table){let action="select",payload,filter;const q={select(){return q;},order(){return q;},eq(column,value){filter={column,value};return q;},upsert(value){action="upsert";payload=value;return q;},insert(value){action="insert";payload=value;return q;},update(value){action="update";payload=value;return q;},single(){return q;},maybeSingle(){return q;},then(resolve,reject){return request(table,action,payload,filter).then(resolve,reject);}};return q;},
        rpc:(table,payload)=>request(table,"rpc",payload),
        storage:{from:()=>({upload:(path,file)=>request("storage","upload",{path,file}),remove:paths=>request("storage","remove",paths)})}};
      return db;
    }
    const auth={setSession:async()=>({data:{user:{id:"doctor-a"}},error:null})};
    for(const method of ["signInWithPassword","updateUser","verifyOtp","resend","resetPasswordForEmail"])auth[method]=async(...args)=>{
      authCalls.push({method,args});
      if(env.authGate && env.authGateMethod===method)await env.authGate.promise;
      if(env.fail)return {data:null,error:env.fail};
      if(env.partialAuth && method==="verifyOtp")return {data:{user:null,session:null},error:null};
      if(method==="updateUser" && args[0].email)pendingEmail=args[0].email;
      if(method==="verifyOtp" && args[0].type==="email_change" && args[0].email===pendingEmail && completeOtp)authoritative={...authoritative,email:pendingEmail};
      if(method==="verifyOtp" && args[0].type==="email_change" && args[0].email!==pendingEmail)return {data:{user:null,session:null},error:null};
      return {data:{user:{...authoritative},session:["signInWithPassword","verifyOtp"].includes(method)?{...session(),user:{...authoritative}}:undefined},error:null};
    };
    return {auth};
  };
  factory=env.factory;return env;
}
async function scopeFor(env,options={}) {
  factory=env.factory;
  return security.createAuthenticatedMutation(env.client,{ expectedUserId:"doctor-a",setTimer:env.window.setTimeout,clearTimer:env.window.clearTimeout,...options });
}
for(const next of [null,session("doctor-b","session-b"),session("doctor-a","replacement")]) {
  const env=environment(),scope=await scopeFor(env);
  env.emit(next?"SIGNED_IN":"SIGNED_OUT",next);
  await rejects(()=>scope.check(),"mutation_cancelled","Logout and same/different-account session replacement cancel writes");
  scope.dispose();check(env.subscribers.size===0,"Cancelled scope cleans its auth subscription");
}
{
  const env=environment(),scope=await scopeFor(env);env.emit("TOKEN_REFRESHED",session());await scope.check();checks++;
  env.authGate=deferred();env.authGateMethod="updateUser";
  const pending=scope.authRequest("updateUser",[{email:"new@example.test"}],"Email request");
  for(let i=0;i<30;i++)await Promise.resolve();env.fireTimeouts();
  await rejects(()=>pending,"auth_request_timeout","Email timeouts reject instead of reporting request success");
  await rejects(()=>scope.authRequest("updateUser",[{}],"Retry"),"request_pending","Timed-out requests retain a duplicate-submission lock until actual settlement");
  env.authGate.resolve();await scope.whenIdle();scope.dispose();check(env.timers.size===0,"Request timers are cleaned after timeout and late response");
}
{
  const env=environment(),scope=await scopeFor(env);env.authGate=deferred();env.authGateMethod="updateUser";
  const pending=scope.authRequest("updateUser",[{email:"new@example.test"}],"Email request");
  for(let i=0;i<30;i++)await Promise.resolve();scope.dispose();
  await rejects(()=>pending,"mutation_cancelled","Unmount cancels waiting Auth request without success callbacks");
  env.authGate.resolve();await scope.whenIdle();check(env.subscribers.size===0&&env.timers.size===0,"Unmount removes auth listener and timeout");
}
// Execute real Settings handlers and effects with synthetic auth/query/timers.
const regression=await source("scripts/verify-role-inactivity.mjs");
const hookStart=regression.indexOf("function hookRuntime()"),hookEnd=regression.indexOf("const element",hookStart);
const hookRuntime = new Function(regression.slice(hookStart,hookEnd)+";return hookRuntime;")();
const settle=async hooks=>{for(let i=0;i<120;i++)await Promise.resolve();hooks?.flush();};
const settingsSource=await source("src/pages/doctor/Doctor_Settings.jsx");
const exposed=settingsSource
 .replace('  return (\n    <section className="doctor-settings-page"', '  const renderTree = () => (\n    <section className="doctor-settings-page"')
 .replace('  );\n}\n\nexport default DoctorSettingsContent;', '  );\n  return { settings, changeEmailState, changePasswordOtp, isSaving, isLoading, toast, message, updateSetting, setPasswordForm, changeEmail, requestEmailChangeOtp, verifyEmailChangeOtp, resendEmailChangeOtp, setChangeEmailField, handlePasswordSubmit, setChangePasswordOtpField, verifyPasswordOtpAndUpdate, saveProfileSettings, saveAccountSettings, toggleProfileCardEdit, closeChangeEmailModal, drafts, fieldErrors, getDraftValue, setActivePanel, scheduleDraft, openScheduleEditor, setScheduleDraft, saveScheduleDraft, loadError, availabilityError, setLoadRevision, editingProfileCards, renderProfileSettingsField, renderTree };\n}\n\nexport default DoctorSettingsContent;');
check(exposed!==settingsSource,"Harness exercises production Settings handlers and effects");
const password=await import("../src/lib/passwordSecurity.js");
const availability=await import("../src/lib/availabilitySchedule.js");
async function settingsHarness(configure = () => {}) {
  const env=environment(),hooks=hookRuntime();configure(env);let logout=0;
  const identity={authUser:session().user,profile:{id:"doctor-a",role:"doctor",account_status:"active"},doctorDisplayName:"Doctor A",personalInformation:{full_name:"Doctor A"},professionalInformation:{}};
  env.loadGate=null;
  const ctx=vm.createContext({console,window:env.window,Event,URL,AbortController});
  const scopedSecurity={...security,createAuthenticatedMutation:(client,options)=>{factory=env.factory;return security.createAuthenticatedMutation(client,{...options,setTimer:env.window.setTimeout,clearTimer:env.window.clearTimeout});}};
  const react={...hooks.runtime};react.default=react;
  const dialogs=await evaluate(await source("src/hooks/useDoctorSettingsDialog.js"),"settings-dialogs.js",{react},ctx);
  const mod=await evaluate(exposed,"settings.jsx",{
    "../../hooks/useDoctorSettingsDialog":dialogs,
    react,"react/jsx-runtime":jsx,"../../context/roleInactivityContext":{DoctorSignOutContext:{value:()=>{logout++;return Promise.resolve();}}},
    "../../lib/doctorSettingsData":settingsData,
    "../../lib/authenticatedMutation":scopedSecurity,"../../lib/roleInactivity":role,
    "../../lib/supabaseClient":{supabase:env.client},"../../hooks/useAuthenticatedDoctor":{loadAuthenticatedDoctor:async user=>{if(env.loadGate)await env.loadGate.promise;return {...identity,authUser:user,profile:{...env.rows.profiles},personalInformation:env.rows.doctor_personal_information?{...env.rows.doctor_personal_information}:null,professionalInformation:env.rows.doctor_professional_information?{...env.rows.doctor_professional_information}:null};}},
    "../../lib/passwordSecurity":password,"../../lib/availabilitySchedule":availability,"../../components/common/PasswordSecurityFeedback":{default:"Feedback"},
  },ctx);
  hooks.mount(mod.default,{doctorIdentity:identity});await settle(hooks);
  check(!hooks.result.isLoading,"Doctor Settings initial data loaded in mock");
  env.hooks=hooks;env.identity=identity;env.logout=()=>logout;
  env.requestEmail=async()=>{await hooks.result.changeEmail();await settle(hooks);hooks.result.setChangeEmailField("newEmail","new@example.test");hooks.result.setChangeEmailField("currentPassword","synthetic-password");hooks.flush();await hooks.result.requestEmailChangeOtp();await settle(hooks);};
  return env;
}
{
 const h=await settingsHarness();await h.requestEmail();
 check(h.hooks.result.changeEmailState.step==="currentOtp"&&!h.hooks.result.changeEmailState.currentEmailVerified,"Sending request never verifies current email locally");
 for(const token of ["","1","12345"]){h.hooks.result.setChangeEmailField("currentEmailOtp",token);h.hooks.flush();const before=h.authCalls.length;await h.hooks.result.verifyEmailChangeOtp("current");await settle(h.hooks);check(h.authCalls.length===before&&!h.hooks.result.changeEmailState.currentEmailVerified,"Short OTP rejected without verify call");}
 h.hooks.result.setChangeEmailField("currentEmailOtp","123456");h.hooks.flush();h.fail={message:"invalid otp"};await h.hooks.result.verifyEmailChangeOtp("current");await settle(h.hooks);
 check(!h.hooks.result.changeEmailState.currentEmailVerified&&h.logout()===0,"Rejected server OTP cannot advance or log out");
 h.fail=null;await h.hooks.result.verifyEmailChangeOtp("current");await settle(h.hooks);
 check(h.authCalls.at(-1).args[0].email==="doctor-a@example.test"&&h.authCalls.at(-1).args[0].type==="email_change","Current-email challenge uses supported server verification");
 check(h.hooks.result.changeEmailState.step==="newOtp"&&h.logout()===0,"First partial confirmation is not email-change success");
 h.hooks.result.setChangeEmailField("newEmailOtp","654321");h.hooks.flush();h.completeOtp=false;await h.hooks.result.verifyEmailChangeOtp("new");await settle(h.hooks);
 check(h.logout()===0&&h.hooks.result.settings.email!=="new@example.test","No-error verify response with old authoritative email cannot announce success");
 h.completeOtp=true;h.hooks.result.setChangeEmailField("newEmailOtp","654321");h.hooks.flush();await h.hooks.result.verifyEmailChangeOtp("new");await settle(h.hooks);
 check(h.hooks.result.settings.email==="new@example.test"&&h.logout()===1,"Authoritative email confirmation delegates exactly one secure logout");
 check(h.current.user.email==="doctor-a@example.test","Isolated Auth calls never replace application session");h.hooks.unmount();
}
for(const kind of ["returned","thrown","timeout","replacement","unmount"]) {
 const h=await settingsHarness();await h.hooks.result.changeEmail();await settle(h.hooks);
 h.hooks.result.setChangeEmailField("newEmail","new@example.test");h.hooks.result.setChangeEmailField("currentPassword","synthetic-password");h.hooks.flush();
 h.authGate=deferred();h.authGateMethod="updateUser";
 const pending=h.hooks.result.requestEmailChangeOtp();await settle(h.hooks);
 const before=h.authCalls.length;await h.hooks.result.requestEmailChangeOtp();await settle(h.hooks);check(h.authCalls.length===before,"Duplicate email request suppressed: "+kind);
 if(kind==="timeout")h.fireTimeouts();
 if(kind==="replacement")h.emit("SIGNED_IN",session("doctor-b","session-b"));
 if(kind==="unmount")h.hooks.unmount();
 if(kind==="returned")h.fail={message:"Synthetic request failed"};
 if(kind==="thrown")h.authGate.reject(Error("Synthetic rejected request"));else h.authGate.resolve();
 await pending;await settle(kind==="unmount"?null:h.hooks);
 check(h.logout()===0&&!h.notices.some(n=>n.type==="doctor-settings-updated"),"Failed/late email cannot notify success or logout: "+kind);
 if(kind!=="unmount")h.hooks.unmount();check(h.subscribers.size===0&&h.timers.size===0,"Email lifecycle cleanup: "+kind);
}
for(const kind of ["account","profile","card"])for(const boundary of ["identity","records"]) {
 const h=await settingsHarness();
 h.hooks.result.updateSetting(kind==="account"?"contactNumber":"displayName","Pending Doctor A",kind==="account"?"account":"personal");h.hooks.flush();
 if(kind==="card"){h.hooks.result.toggleProfileCardEdit("personal");h.hooks.flush();}
 if(boundary==="identity")h.loadGate=deferred();else{h.writeGate=deferred();h.writeGateTable=kind==="account"?"doctor_professional_information":"doctor_personal_information";}
 const event={preventDefault(){}};
 const pending=kind==="card"?h.hooks.result.toggleProfileCardEdit("personal"):h.hooks.result[kind==="account"?"saveAccountSettings":"saveProfileSettings"](event);
 await settle(h.hooks);const before=h.writes.length;
 h.emit("SIGNED_IN",session("doctor-b","session-b"));
 (boundary==="identity"?h.loadGate:h.writeGate).resolve();await pending;await settle(h.hooks);
 check(h.writes.length===before&&!h.writes.some(w=>w.table==="sync_current_profile_email"),"Account replacement prevents later saves/RPC: "+kind+"/"+boundary);
 check(h.writes.every(w=>!w.payload?.auth_user_id||w.payload.auth_user_id==="doctor-a"),"Pending form never targets Doctor B: "+kind+"/"+boundary);
 h.hooks.unmount();
}
for(const abandon of ["logout","unmount"]) {
 const h=await settingsHarness();h.hooks.result.updateSetting("displayName","Pending A","personal");h.hooks.flush();h.writeGate=deferred();h.writeGateTable="doctor_personal_information";
 const pending=h.hooks.result.saveProfileSettings({preventDefault(){}});await settle(h.hooks);
 if(abandon==="logout")h.emit("SIGNED_OUT",null);else h.hooks.unmount();
 h.writeGate.resolve();await pending;await settle(abandon==="unmount"?null:h.hooks);
 check(!h.writes.some(w=>w.table==="profiles"||w.table==="sync_current_profile_email")&&!h.notices.length,"Pending profile write has no follow-up after "+abandon);
 if(abandon!=="unmount")h.hooks.unmount();
}
{
 const h=await settingsHarness();h.hooks.result.updateSetting("contactNumber","New contact","account");h.hooks.flush();h.writeGate=deferred();h.writeGateTable="doctor_professional_information";
 const a=h.hooks.result.saveAccountSettings({preventDefault(){}}),b=h.hooks.result.saveAccountSettings({preventDefault(){}});await settle(h.hooks);
 check(h.writes.filter(w=>w.table==="doctor_professional_information").length===1,"Duplicate account save has one write sequence");h.writeGate.resolve();await Promise.all([a,b]);await settle(h.hooks);h.hooks.unmount();
}
// Avatar production utility: pending storage completion must not call an ownership RPC.
const avatarSource=await source("src/lib/profilePicture.js");
for(const abandon of ["replacement","logout","unmount"]) {
 const env=environment();let alive=true;env.writeGate=deferred();env.writeGateTable="storage";factory=env.factory;
 const ctx=vm.createContext({console,Date,window:env.window,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}});
 const avatar=await evaluate(avatarSource,"avatar.js",{"./supabaseClient":{supabase:env.client},"./authenticatedMutation":security},ctx);
 const pending=avatar.uploadProfilePicture({type:"image/png",size:100},{expectedUserId:"doctor-a",isCurrent:()=>alive});
 await settle();
 if(abandon==="replacement")env.emit("SIGNED_IN",session("doctor-b","session-b"));if(abandon==="logout")env.emit("SIGNED_OUT",null);if(abandon==="unmount")alive=false;
 env.writeGate.resolve();await rejects(()=>pending,"mutation_cancelled","Avatar upload stops completion RPC after "+abandon);
 check(!env.writes.some(w=>w.table==="set_current_user_avatar_url")&&env.notices.length===0,"No stale avatar RPC or broadcast: "+abandon);
 check(env.subscribers.size===0,"Avatar scope listener cleanup: "+abandon);
}
// Normal upload/remove preserve utility return values and ownership behavior.
for(const action of ["upload","remove"]){
 const env=environment();factory=env.factory;
 const ctx=vm.createContext({console,Date,window:env.window,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}});
 const avatar=await evaluate(avatarSource,"avatar-success.js",{"./supabaseClient":{supabase:env.client},"./authenticatedMutation":security},ctx);
 const result=action==="upload"?await avatar.uploadProfilePicture({type:"image/png",size:100},{expectedUserId:"doctor-a"}):await avatar.removeProfilePicture({expectedUserId:"doctor-a"});
 check(result.userId==="doctor-a"&&typeof result.displayUrl==="string"&&result.displayUrl===result.storedValue,"Successful avatar utility return contract: "+action);
 check(env.writes.filter(w=>w.table==="set_current_user_avatar_url").length===1&&env.notices.length===1,"Successful avatar RPC and one broadcast: "+action);
 check(env.subscribers.size===0,"Successful avatar scope disposal: "+action);
}
{
 const env=environment();factory=env.factory;env.writeGate=deferred();env.writeGateTable="storage";
 const ctx=vm.createContext({console,Date,window:env.window,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}});
 const avatar=await evaluate(avatarSource,"avatar-rollback.js",{"./supabaseClient":{supabase:env.client},"./authenticatedMutation":security},ctx);
 const pending=avatar.removeProfilePicture({expectedUserId:"doctor-a"});await settle();
 check(env.writes.filter(w=>w.table==="set_current_user_avatar_url").length===1,"Avatar removal clears owned URL before storage deletion");
 env.emit("SIGNED_IN",session("doctor-b","session-b"));env.fail={message:"Synthetic storage failed"};env.writeGate.resolve();
 await rejects(()=>pending,"mutation_cancelled","Replacement during removal blocks stale avatar rollback");
 check(env.writes.filter(w=>w.table==="set_current_user_avatar_url").length===1&&env.notices.length===0,"No rollback or broadcast under Doctor B");
}

// Teardown during initial session capture must unsubscribe synchronously.
{
 const env=environment(),gate=deferred(),abort=new AbortController();env.client.auth.getSession=()=>gate.promise;
 const capture=scopeFor(env,{signal:abort.signal});check(env.subscribers.size===1,"Session capture subscribes before its asynchronous boundary");abort.abort();
 check(env.subscribers.size===0,"Abort removes session-capture subscription immediately");gate.resolve({data:{session:session()},error:null});await rejects(()=>capture,"mutation_cancelled","Aborted session capture cannot create a mutation client");
}
{
 const h=await settingsHarness();await h.requestEmail();h.authoritative={...h.authoritative,email:"new@example.test"};h.emit("USER_UPDATED",{...h.current,user:{...h.current.user,email:"new@example.test"}});
 check([...h.timers.values()].some(t=>t.delay===0),"Auth event defers confirmation outside the SDK lock");h.hooks.unmount();check(h.timers.size===0,"Unmount clears deferred Auth confirmation timers");h.fireTimeouts();await settle();check(h.logout()===0,"Cleared late confirmation timer cannot initiate logout");
}
{
 const h=await settingsHarness();await h.hooks.result.changeEmail();await settle(h.hooks);h.hooks.result.setChangeEmailField("newEmail","new@example.test");h.hooks.result.setChangeEmailField("currentPassword","synthetic-password");h.hooks.flush();h.authGate=deferred();h.authGateMethod="updateUser";
 const pending=h.hooks.result.requestEmailChangeOtp();await settle(h.hooks);h.fireTimeouts();await pending;await settle(h.hooks);
 check(h.hooks.result.changeEmailState.error.includes("outcome is unknown")&&!h.hooks.result.changeEmailState.success,"Timeout UI explains uncertainty without false success");
 h.hooks.result.closeChangeEmailModal();h.hooks.flush();check(!h.hooks.result.changeEmailState.isOpen,"Timed-out dialog can close for recovery without unlocking pending network work");
 const before=h.authCalls.length;await h.hooks.result.requestEmailChangeOtp();await settle(h.hooks);check(h.authCalls.length===before,"Closing timed-out dialog cannot duplicate an unresolved request");
 h.authGate.resolve();await settle(h.hooks);check(!h.hooks.result.changeEmailState.isOpen&&h.logout()===0,"Late request cannot reopen cancelled flow or logout");h.hooks.unmount();
}

// Recovery verification needs an Auth-issued session before a password write.
async function requestPassword(h) {
 h.hooks.result.setPasswordForm({currentPassword:"synthetic-current",newPassword:"Synthetic!Secure9",confirmPassword:"Synthetic!Secure9"});h.hooks.flush();
 await h.hooks.result.handlePasswordSubmit({preventDefault(){}});await settle(h.hooks);
 check(h.hooks.result.changePasswordOtp.isOpen,"Password OTP flow opened after password verification");
}
{
 const h=await settingsHarness();await requestPassword(h);
 for(const token of ["1","12345"]){h.hooks.result.setChangePasswordOtpField("otp",token);h.hooks.flush();const before=h.authCalls.length;await h.hooks.result.verifyPasswordOtpAndUpdate();await settle(h.hooks);check(h.authCalls.length===before&&h.logout()===0,"Short recovery OTP cannot update a password");}
 h.hooks.result.setChangePasswordOtpField("otp","123456");h.hooks.flush();h.partialAuth=true;
 await h.hooks.result.verifyPasswordOtpAndUpdate();await settle(h.hooks);
 check(!h.authCalls.some(c=>c.method==="updateUser"&&c.args[0].password)&&h.logout()===0,"Recovery response without Auth session cannot authorize password update");
 h.partialAuth=false;h.authGate=deferred();h.authGateMethod="verifyOtp";
 const first=h.hooks.result.verifyPasswordOtpAndUpdate();await settle(h.hooks);const before=h.authCalls.length;
 await h.hooks.result.verifyPasswordOtpAndUpdate();await settle(h.hooks);
 check(h.authCalls.length===before,"Duplicate recovery verification suppressed");
 h.authGate.resolve();await first;await settle(h.hooks);
 check(h.authCalls.filter(c=>c.method==="updateUser"&&c.args[0].password).length===1&&h.logout()===1,"Verified password update delegates once to clinic logout");
 check(h.current.user.id==="doctor-a"&&role.getLogicalSessionIdentity(h.current)==="doctor-a:session-a","Recovery sign-in never replaces the application session");h.hooks.unmount();
}
for(const abandon of ["replacement","logout","unmount"]){
 const h=await settingsHarness();await requestPassword(h);h.hooks.result.setChangePasswordOtpField("otp","123456");h.hooks.flush();h.authGate=deferred();h.authGateMethod="verifyOtp";
 const pending=h.hooks.result.verifyPasswordOtpAndUpdate();await settle(h.hooks);
 if(abandon==="replacement")h.emit("SIGNED_IN",session("doctor-b","session-b"));else if(abandon==="logout")h.emit("SIGNED_OUT",null);else h.hooks.unmount();
 h.authGate.resolve();await pending;await settle(abandon==="unmount"?null:h.hooks);
 check(!h.authCalls.some(c=>c.method==="updateUser"&&c.args[0].password)&&h.logout()===0,"Late recovery cannot update credentials or logout replacement: "+abandon);
 if(abandon!=="unmount")h.hooks.unmount();
}
// Production photo component guards rapid actions and callbacks after teardown.
{
 const hooks=hookRuntime(),gate=deferred();let uploads=0,changes=0,signal;
 const ctx=vm.createContext({console,AbortController,window:{requestAnimationFrame:()=>0},document:{addEventListener(){},removeEventListener(){}}});
 const react={...hooks.runtime};react.default=react;
 const photo=await evaluate(await source("src/components/common/ProfilePictureActions.jsx"),"photo.jsx",{react,"react/jsx-runtime":jsx,"@iconify/react":{Icon:"Icon"},"../../lib/profilePicture":{uploadProfilePicture:async(file,options)=>{uploads++;signal=options.signal;return gate.promise;},removeProfilePicture:async()=>({displayUrl:"",storedValue:""})}},ctx);
 hooks.mount(photo.default,{expectedUserId:"doctor-a",onChange:()=>changes++});
 const input=hooks.result.props.children.find(node=>node.type==="input"),event=()=>({target:{files:[{type:"image/png",size:10}],value:"fake"}});
 const pending=input.props.onChange(event());await input.props.onChange(event());check(uploads===1,"Rapid avatar submissions start one upload");
 hooks.unmount();check(signal.aborted,"Photo unmount aborts initialization and waiting auth scopes immediately");gate.resolve({displayUrl:"synthetic",storedValue:"synthetic"});await pending;
 check(changes===0,"Unmounted avatar completion cannot call the Doctor parent onChange");
}
// Actual SDK RPC binds Authorization to captured A even if B replaces the store
// after token acquisition. Backend ownership still evaluates A's JWT.
{
 const env=environment();let authorization;
 const bound=await scopeFor(env,{makeClient:(url,key,options)=>createClient(url,key,{...options,global:{fetch:async(url,request)=>{authorization=new Headers(request.headers).get("Authorization");env.emit("SIGNED_IN",session("doctor-b","session-b"));return new Response("null",{status:200,headers:{"Content-Type":"application/json"}});}}})});
 await bound.client.rpc("synthetic_owned_rpc");
 check(authorization==="Bearer "+session().access_token,"Installed SDK RPC retains A's captured token through a store replacement");
 await rejects(()=>bound.check(),"mutation_cancelled","No follow-up after installed SDK request sees replacement");bound.dispose();
}
check(!settingsSource.includes("supabase.auth.signOut")&&!settingsSource.includes("navigate("),"Credential handlers have no independent signOut or unconditional Login redirect");
check(settingsSource.includes("const request = requestDoctorSignOut()"),"Credentials share the existing controller's returned/thrown errors, duplicate lock and blocked retry behavior");

// Exercise installed SDK partial email confirmation with synthetic HTTP only.
{
 const requests=[];
 const sdk=createClient("https://synthetic.supabase.test","synthetic-public",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({msg:"Confirmation link accepted. Please proceed to confirm link sent to the other email",code:"200"}),{status:200,headers:{"Content-Type":"application/json"}});}}});
 const result=await sdk.auth.verifyOtp({email:"old@example.test",token:"123456",type:"email_change"});
 check(!result.error&&!result.data.session&&!result.data.user?.email,"Installed SDK partial confirmation supplies no authoritative changed email");
 check(requests.length===1&&requests[0].type==="email_change","Installed SDK sends supported type to Auth verify endpoint");
}
// Batch 2: production persistence, draft isolation, validation and recovery.
const batch1Checks = checks;
const submitEvent = {preventDefault(){}};
const edit = (h, section, field, value) => { h.hooks.result.updateSetting(field,value,section);h.hooks.flush(); };
const saveCard = async (h,card) => {
 if(!h.hooks.result.editingProfileCards[card]){h.hooks.result.toggleProfileCardEdit(card);h.hooks.flush();}
 await h.hooks.result.toggleProfileCardEdit(card);await settle(h.hooks);
};
const refresh = async h => {
 h.hooks.update({doctorIdentity:{...h.identity,profile:{...h.rows.profiles},personalInformation:{...h.rows.doctor_personal_information},professionalInformation:{...h.rows.doctor_professional_information}}});
 await settle(h.hooks);
};
const noSuccess = h => h.hooks.result.toast?.type !== "success" && !h.notices.some(n=>n.type==="doctor-settings-updated");
{
 const h=await settingsHarness();edit(h,"personal","displayName","Personal Saved");edit(h,"professional","clinicName","Unsaved Clinic");edit(h,"professional","contactNumber","Unsaved Contact");
 await saveCard(h,"personal");
 check(h.rows.doctor_personal_information.full_name==="Personal Saved"&&h.rows.profiles.full_name==="Personal Saved","Personal name persists and required shared name sync succeeds");
 check(!h.writes.some(w=>w.table==="doctor_professional_information"),"Personal Done never writes Professional draft");
 check(h.hooks.result.getDraftValue("professional","clinicName")==="Unsaved Clinic"&&h.hooks.result.getDraftValue("professional","contactNumber")==="Unsaved Contact","Unrelated Professional drafts survive Personal save");
 check(Object.keys(h.writes.find(w=>w.table==="doctor_personal_information").payload).sort().join() === "auth_user_id,full_name","Personal payload contains only submitted personal fields and ownership");
 check(!Object.keys(h.hooks.result.drafts.personal).length&&h.hooks.result.toast.type==="success","Confirmed Personal save clears only its draft and notifies success");h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","displayName","Unsaved Personal");edit(h,"professional","clinicName","Professional Saved");
 await saveCard(h,"professional");
 check(!h.writes.some(w=>w.table==="doctor_personal_information"||w.table==="profiles"),"Professional clinic save never persists unrelated Personal edits or shared name");
 check(h.rows.doctor_professional_information.clinic_hospital_name==="Professional Saved"&&h.hooks.result.getDraftValue("personal","displayName")==="Unsaved Personal","Professional canonical readback preserves Personal draft");h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","displayName","Unsaved Personal");edit(h,"professional","clinicName","Unsaved Clinic");edit(h,"professional","contactNumber","Professional Draft");edit(h,"account","contactNumber","Account Saved");
 await h.hooks.result.saveAccountSettings(submitEvent);await settle(h.hooks);
 check(h.rows.doctor_professional_information.contact_number==="Account Saved"&&h.rows.profiles.contact_number==="Account Saved","Account contact and required shared contact both persist");
 check(!h.writes.some(w=>w.table==="doctor_personal_information")&&h.rows.doctor_professional_information.clinic_hospital_name==="Original Clinic","Account save never persists Profile drafts");
 check(Object.keys(h.writes.find(w=>w.table==="doctor_professional_information").payload).sort().join()==="auth_user_id,contact_number","Account payload contains only its dirty contact and ownership");
 h.hooks.result.setActivePanel("profile");h.hooks.flush();
 check(h.hooks.result.getDraftValue("professional","contactNumber")==="Professional Draft"&&h.hooks.result.getDraftValue("account","contactNumber")==="Account Saved","Section switching keeps independent shared-field drafts");
 check(h.hooks.result.getDraftValue("personal","displayName")==="Unsaved Personal","Account save retains Personal draft");h.hooks.unmount();
}
for(const kind of ["returned","thrown"]){
 const h=await settingsHarness();edit(h,"personal","displayName","Partially Saved");h.failure={table:"profiles",action:"update",kind};
 await saveCard(h,"personal");
 check(noSuccess(h)&&h.hooks.result.message.includes("Some changes were saved"),"Required shared write failure explicitly reports partial save: "+kind);
 check(!h.hooks.result.isSaving&&h.hooks.result.drafts.personal.displayName==="Partially Saved","Partial failure releases busy and retains retry draft: "+kind);
 check(h.hooks.result.settings.displayName==="Partially Saved"&&h.rows.profiles.full_name==="Doctor A","Partial readback displays confirmed primary data: "+kind);
 edit(h,"personal","displayName","Partially Saved");
 check(h.hooks.result.drafts.personal.displayName==="Partially Saved","Matching a partially saved value must retain its required retry: "+kind);
 h.failure=null;await saveCard(h,"personal");
 check(h.rows.profiles.full_name==="Partially Saved"&&h.hooks.result.toast.type==="success"&&!Object.keys(h.hooks.result.drafts.personal).length,"Retry completes partial synchronization safely: "+kind);h.hooks.unmount();
}
for(const kind of ["returned","thrown"]){
 const h=await settingsHarness();edit(h,"professional","clinicName","Retry Clinic");h.failure={table:"doctor_professional_information",action:"upsert",kind};
 await saveCard(h,"professional");
 check(noSuccess(h)&&!h.hooks.result.isSaving&&h.hooks.result.drafts.professional.clinicName==="Retry Clinic","Failed primary write retains draft, releases busy and prevents success: "+kind);
 h.failure=null;await saveCard(h,"professional");check(h.rows.doctor_professional_information.clinic_hospital_name==="Retry Clinic","Retry after primary failure succeeds: "+kind);h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","nationality","Saved Nationality");edit(h,"professional","clinicName","Retry Clinic");h.failure={table:"doctor_professional_information",action:"upsert",kind:"thrown"};
 await h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);
 check(noSuccess(h)&&h.hooks.result.message.includes("Some selected cards were saved"),"Profile footer reports partial completion across cards");
 check(!Object.keys(h.hooks.result.drafts.personal).length&&h.hooks.result.drafts.professional.clinicName==="Retry Clinic","Multi-card partial save clears completed card only");
 h.failure=null;await h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);
 check(h.writes.filter(w=>w.table==="doctor_personal_information").length===1&&h.rows.doctor_professional_information.clinic_hospital_name==="Retry Clinic","Multi-card retry only retries remaining draft");h.hooks.unmount();
}
for(const value of ["-1","1.5","2.0","one","3oops","3 Years extra","+3","1e2","2147483648"]){
 assert.throws(()=>settingsData.parseDoctorExperience(value));checks++;
}
for(const [value,expected] of [["",null],["  ",null],[null,null],["0",0],["12",12],["12 Years",12]])check(settingsData.parseDoctorExperience(value)===expected,"Experience correctly preserves unknown or whole value: "+value);
for(const value of ["2023-02-29","2024-02-30","2024-04-31","2024-13-01","2024-00-01","2024-01-00","0000-01-01","April 31, 2024","2024-2-1","tomorrow"]){
 assert.throws(()=>settingsData.parseDoctorCalendarDate(value));checks++;
}
for(const [value,expected] of [["",null],[null,null],["2024-02-29","2024-02-29"],["January 31, 2003","2003-01-31"],["0001-01-01","0001-01-01"]])check(settingsData.parseDoctorCalendarDate(value)===expected,"Actual calendar date or unset preserved: "+value);
{
 const h=await settingsHarness(env=>{env.rows.doctor_personal_information.civil_status="Single";});edit(h,"personal","yearsExperience","-3");edit(h,"personal","birthdate","2023-02-29");edit(h,"professional","clinicName","Valid Draft");
 await h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);
 check(h.writes.length===0&&noSuccess(h)&&!h.hooks.result.isSaving,"Invalid fields prevent all selected writes without leaving busy state");
 check(h.hooks.result.fieldErrors.personal.yearsExperience&&h.hooks.result.fieldErrors.personal.birthdate,"Experience and calendar errors have field-level feedback");
 edit(h,"personal","yearsExperience","0");edit(h,"personal","birthdate","2024-02-29");await saveCard(h,"personal");
 check(h.rows.doctor_personal_information.years_of_experience===0&&h.rows.doctor_personal_information.birthdate==="2024-02-29","Corrected valid date and intended zero persist");
 edit(h,"personal","yearsExperience","");edit(h,"personal","birthdate","");edit(h,"personal","civilStatus","");edit(h,"personal","displayName","");await saveCard(h,"personal");
 check(h.rows.doctor_personal_information.years_of_experience===null&&h.rows.doctor_personal_information.birthdate===null&&h.rows.doctor_personal_information.civil_status===null,"Clearing optional experience/date/dropdown stores null instead of zero");
 check(h.hooks.result.settings.displayName===""&&h.hooks.result.settings.yearsExperience==="","Explicit cleared canonical values do not resurrect fallback data");
 const field=h.hooks.result.renderProfileSettingsField({label:"Civil Status",field:"civilStatus",options:["Single","Married"]},true);
 check(field.props.children[1].props.children[0].props.value==="","Optional dropdown supplies an unset choice");h.hooks.unmount();
}
for(const section of ["personal","professional","account","schedule"]){
 const h=await settingsHarness();
 if(section==="schedule"){h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();}
 else {edit(h,section,section==="personal"?"nationality":section==="account"?"contactNumber":"clinicName","One Save");if(section!=="account"){h.hooks.result.toggleProfileCardEdit(section);h.hooks.flush();}}
 h.writeGate=deferred();h.writeGateTable=section==="schedule"?"user_availability":section==="personal"?"doctor_personal_information":"doctor_professional_information";
 const submit=()=>section==="schedule"?h.hooks.result.saveScheduleDraft(submitEvent):section==="account"?h.hooks.result.saveAccountSettings(submitEvent):h.hooks.result.toggleProfileCardEdit(section);
 const first=submit(),second=submit();h.hooks.flush();
 check(h.hooks.result.isSaving,"Busy state begins before first await: "+section);
 const field=h.hooks.result.renderProfileSettingsField({label:"Name",field:"displayName"},true);
 check(field.props.children[1].props.disabled,"Profile input disabled during shared in-flight operation: "+section);
 await settle(h.hooks);check(h.writes.filter(w=>w.table===h.writeGateTable).length===1,"Duplicate rapid clicks cause one write: "+section);
 await h.hooks.result.saveAccountSettings(submitEvent);await h.hooks.result.saveProfileSettings(submitEvent);
 check(h.writes.filter(w=>w.table===h.writeGateTable).length===1,"Overlapping controls cannot initiate another save: "+section);
 h.writeGate.resolve();await Promise.all([first,second]);await settle(h.hooks);
 check(!h.hooks.result.isSaving&&h.hooks.result.toast.type==="success","Successful save releases lock: "+section);h.hooks.unmount();
}
for(const section of ["personal","account","schedule"]){
 const h=await settingsHarness();const original=h.client.auth.getUser;
 if(section==="schedule"){h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();}else edit(h,section,section==="personal"?"nationality":"contactNumber","Recovered");
 const submit=()=>section==="schedule"?h.hooks.result.saveScheduleDraft(submitEvent):h.hooks.result[section==="personal"?"saveProfileSettings":"saveAccountSettings"](submitEvent);
 h.client.auth.getUser=async()=>{throw Error("Synthetic rejected getUser");};await submit();await settle(h.hooks);
 check(!h.hooks.result.isSaving&&h.writes.length===0&&noSuccess(h),"Rejected authenticated user lookup releases busy and blocks writes: "+section);
 h.client.auth.getUser=original;await submit();await settle(h.hooks);
 check(h.hooks.result.toast.type==="success"&&h.writes.length>0,"Rejected lookup is retryable: "+section);h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","nationality","Retry Session");const original=h.client.auth.getSession;
 h.client.auth.getSession=async()=>{throw Error("Synthetic rejected getSession");};await h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);
 check(!h.hooks.result.isSaving&&noSuccess(h)&&h.hooks.result.message.includes("retry"),"Rejected initial session capture releases lock with retry feedback");
 h.client.auth.getSession=original;await h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);check(h.hooks.result.toast.type==="success","Session capture failure permits a later retry");h.hooks.unmount();
}
for(const kind of ["returned","thrown"]){
 const h=await settingsHarness(env=>{env.rows.user_availability=[{profile_id:"doctor-a",day_of_week:1,start_time:"08:00:00",end_time:"12:00:00",is_available:true}];});
 const prior=JSON.stringify(h.hooks.result.settings.availability);h.failure={table:"user_availability",action:"select",kind};await refresh(h);
 check(!h.hooks.result.isLoading&&h.hooks.result.loadError&&h.hooks.result.availabilityError,"Availability loading error ends loading and offers retry: "+kind);
 check(JSON.stringify(h.hooks.result.settings.availability)===prior,"Rejected availability refresh preserves prior valid list: "+kind);
 h.failure=null;h.hooks.result.setLoadRevision(n=>n+1);h.hooks.flush();await settle(h.hooks);
 check(!h.hooks.result.loadError&&!h.hooks.result.availabilityError,"Availability retry clears errors: "+kind);
 h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();h.failure={table:"user_availability",action:"upsert",kind};
 await h.hooks.result.saveScheduleDraft(submitEvent);await settle(h.hooks);
 check(!h.hooks.result.isSaving&&h.hooks.result.scheduleDraft&&JSON.stringify(h.hooks.result.settings.availability)===prior&&noSuccess(h),"Failed Schedule write preserves draft/list and releases lock: "+kind);
 h.failure=null;await h.hooks.result.saveScheduleDraft(submitEvent);await settle(h.hooks);check(!h.hooks.result.scheduleDraft&&h.hooks.result.toast.type==="success","Schedule failure supports safe retry: "+kind);h.hooks.unmount();
}
{
 const h=await settingsHarness(env=>{env.client.auth.getUser=async()=>{throw Error("Synthetic initial lookup failure");};});
 check(h.hooks.result.loadError&&!h.hooks.result.isLoading,"Initial rejected identity lookup shows recovery feedback instead of perpetual loading");
 h.client.auth.getUser=async()=>({data:{user:h.authoritative},error:null});h.hooks.result.setLoadRevision(n=>n+1);h.hooks.flush();await settle(h.hooks);
 check(!h.hooks.result.loadError&&h.hooks.result.settings.displayName==="Doctor A","Initial identity failure recovers via retry");h.hooks.unmount();
}
{
 const h=await settingsHarness();h.hooks.result.setPasswordForm({currentPassword:"synthetic-current",newPassword:"Synthetic!Secure9",confirmPassword:"Synthetic!Secure9"});h.hooks.flush();h.authGate=deferred();h.authGateMethod="signInWithPassword";
 const pending=h.hooks.result.handlePasswordSubmit(submitEvent);await settle(h.hooks);h.authGate.reject(Error("Synthetic reauthentication rejection"));await pending;await settle(h.hooks);
 check(!h.hooks.result.isSaving&&!h.hooks.result.changePasswordOtp.isOpen&&h.hooks.result.toast?.type!=="success","Rejected reauthentication releases busy without advancing password flow");
 h.authGate=null;await h.hooks.result.handlePasswordSubmit(submitEvent);await settle(h.hooks);check(h.hooks.result.changePasswordOtp.isOpen,"Rejected reauthentication allows retry");h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","displayName","Dirty Name");edit(h,"professional","clinicName","Dirty Clinic");edit(h,"account","contactNumber","Dirty Account Contact");
 h.rows.doctor_personal_information={...h.rows.doctor_personal_information,full_name:"Refreshed Name",nationality:"Refreshed Nationality"};
 h.rows.doctor_professional_information={...h.rows.doctor_professional_information,clinic_hospital_name:"Refreshed Clinic",contact_number:"Refreshed Contact",license_number:"Refreshed License"};await refresh(h);
 check(h.hooks.result.settings.displayName==="Refreshed Name"&&h.hooks.result.settings.clinicName==="Refreshed Clinic","Actual identity refresh reconciles canonical saved state");
 check(h.hooks.result.getDraftValue("personal","displayName")==="Dirty Name"&&h.hooks.result.getDraftValue("professional","clinicName")==="Dirty Clinic"&&h.hooks.result.getDraftValue("account","contactNumber")==="Dirty Account Contact","Refresh does not overwrite dirty drafts in any section");
 check(h.hooks.result.getDraftValue("personal","nationality")==="Refreshed Nationality"&&h.hooks.result.getDraftValue("professional","licenseNumber")==="Refreshed License"&&h.hooks.result.getDraftValue("professional","contactNumber")==="Refreshed Contact","Unmodified fields synchronize after authoritative refresh");h.hooks.unmount();
}
{
 const h=await settingsHarness();h.readGate=deferred();h.hooks.result.setLoadRevision(n=>n+1);h.hooks.flush();await settle(h.hooks);
 edit(h,"personal","nationality","Saved During Read");await h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);
 h.readGate.resolve();await settle(h.hooks);
 check(h.hooks.result.settings.nationality==="Saved During Read","Late availability response cannot restore older profile snapshot");h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","nationality","Pending Save");h.writeGate=deferred();h.writeGateTable="doctor_personal_information";
 const pending=h.hooks.result.saveProfileSettings(submitEvent);await settle(h.hooks);h.rows.doctor_professional_information.clinic_hospital_name="Fresh Other Card";await refresh(h);
 h.writeGate.resolve();await pending;await settle(h.hooks);
 check(h.hooks.result.settings.nationality==="Pending Save"&&h.hooks.result.toast.type==="success","Same-session identity refresh does not cancel a valid pending save");
 check(h.hooks.result.settings.clinicName==="Fresh Other Card","Late scoped save cannot overwrite refreshed unrelated card data");h.hooks.unmount();
}
for(const abandon of ["replacement","logout","unmount"]){
 const h=await settingsHarness();h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();h.writeGate=deferred();h.writeGateTable="user_availability";
 const pending=h.hooks.result.saveScheduleDraft(submitEvent);await settle(h.hooks);
 if(abandon==="unmount")h.hooks.unmount();else {h.emit(abandon==="logout"?"SIGNED_OUT":"SIGNED_IN",abandon==="logout"?null:session("doctor-b","session-b"));h.hooks.flush();check(!h.hooks.result.isSaving&&h.hooks.result.scheduleDraft===null,"Session transition releases busy and clears pending schedule: "+abandon);}
 h.writeGate.resolve();await pending;await settle(abandon==="unmount"?null:h.hooks);
 check(h.writes.length===1&&h.writes[0].payload.profile_id==="doctor-a"&&h.writes[0].token===session().access_token,"Late Schedule write remains bound to initiating A token: "+abandon);
 check(h.hooks.result.toast?.type!=="success"&&h.notices.length===0,"Late Schedule result has no success or callback after "+abandon);if(abandon!=="unmount")h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"personal","displayName","Unsaved Name");edit(h,"professional","clinicName","Unsaved Clinic");edit(h,"account","contactNumber","Unsaved Contact");await h.requestEmail();
 h.hooks.result.setChangeEmailField("currentEmailOtp","123456");h.hooks.flush();await h.hooks.result.verifyEmailChangeOtp("current");await settle(h.hooks);
 h.hooks.result.setChangeEmailField("newEmailOtp","123456");h.hooks.flush();await h.hooks.result.verifyEmailChangeOtp("new");await settle(h.hooks);
 check(!h.writes.some(w=>w.table==="doctor_personal_information"||w.table==="profiles"),"Credential email sync never writes profile/account drafts");
 const write=h.writes.find(w=>w.table==="doctor_professional_information");check(Object.keys(write.payload).sort().join()==="auth_user_id,email_address","Email completion persists only authoritative email");
 check(h.logout()===1&&h.rows.doctor_professional_information.clinic_hospital_name==="Original Clinic"&&h.rows.profiles.contact_number==="original-contact","Batch 1 verified credential logout preserved without leaking drafts");h.hooks.unmount();
}
{
 const h=await settingsHarness();h.hooks.result.toggleProfileCardEdit("personal");h.hooks.flush();await h.hooks.result.toggleProfileCardEdit("personal");h.hooks.flush();
 check(!h.hooks.result.editingProfileCards.personal&&h.writes.length===0,"Unchanged Personal Done exits edit mode without unnecessary writes");h.hooks.unmount();
}
for(const table of ["doctor_personal_information","profiles","sync_current_profile_email"]){
 const h=await settingsHarness();const section=table==="sync_current_profile_email"?"account":"personal";
 edit(h,section,section==="account"?"email":"displayName",section==="account"?"DOCTOR-A@example.test":"Readback Name");h.invalidReadback={table,data:null};
 await h.hooks.result[section==="account"?"saveAccountSettings":"saveProfileSettings"](submitEvent);await settle(h.hooks);
 check(noSuccess(h)&&!h.hooks.result.isSaving&&h.hooks.result.message.includes("Some changes were saved"),"No-row or empty required readback cannot announce full success: "+table);
 check(Object.keys(h.hooks.result.drafts[section]).length>0,"Unconfirmed required readback retains safe retry plan: "+table);
 h.invalidReadback=null;await h.hooks.result[section==="account"?"saveAccountSettings":"saveProfileSettings"](submitEvent);await settle(h.hooks);
 check(h.hooks.result.toast.type==="success","Readback failure recovers on retry: "+table);h.hooks.unmount();
}
{
 const h=await settingsHarness();edit(h,"account","email","unverified@example.test");edit(h,"account","contactNumber","Retained Contact");
 await h.hooks.result.saveAccountSettings(submitEvent);await settle(h.hooks);
 check(h.writes.length===0&&h.hooks.result.fieldErrors.account.email&&!h.hooks.result.isSaving,"Account draft cannot bypass authoritative email-change workflow");
 edit(h,"account","email","doctor-a@example.test");await h.hooks.result.saveAccountSettings(submitEvent);await settle(h.hooks);
 check(h.rows.profiles.contact_number==="Retained Contact"&&h.hooks.result.toast.type==="success","Correcting email validation retains and saves other valid Account draft");h.hooks.unmount();
}
for(const section of ["personal","account","schedule"]){
 const h=await settingsHarness();
 if(section==="schedule"){h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();}else edit(h,section,section==="personal"?"nationality":"contactNumber","Loader Recovery");
 h.loadGate=deferred();const submit=()=>section==="schedule"?h.hooks.result.saveScheduleDraft(submitEvent):h.hooks.result[section==="personal"?"saveProfileSettings":"saveAccountSettings"](submitEvent);
 const pending=submit();await settle(h.hooks);h.loadGate.reject(Error("Synthetic identity loader rejection"));await pending;await settle(h.hooks);
 check(!h.hooks.result.isSaving&&h.writes.length===0&&noSuccess(h),"Rejected Doctor identity loader releases busy and blocks writes: "+section);
 h.loadGate=null;await submit();await settle(h.hooks);check(h.hooks.result.toast.type==="success","Rejected Doctor identity loader allows retry: "+section);h.hooks.unmount();
}
{
 const h=await settingsHarness();h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();
 h.readGate=deferred();h.captureAvailabilityRead=true;h.hooks.result.setLoadRevision(n=>n+1);h.hooks.flush();await settle(h.hooks);
 await h.hooks.result.saveScheduleDraft(submitEvent);await settle(h.hooks);const saved=JSON.stringify(h.hooks.result.settings.availability);
 h.readGate.resolve();await settle(h.hooks);
 check(h.hooks.result.settings.availability.length===1&&JSON.stringify(h.hooks.result.settings.availability)===saved,"Older in-flight availability snapshot cannot erase a confirmed Schedule save");h.hooks.unmount();
}
{
 const h=await settingsHarness();h.hooks.result.openScheduleEditor({day:"Monday",time:"8:00 AM - 12:00 PM",status:"Available"});h.hooks.flush();h.invalidReadback={table:"user_availability",data:{profile_id:"doctor-a",day_of_week:1}};
 await h.hooks.result.saveScheduleDraft(submitEvent);await settle(h.hooks);
 check(h.hooks.result.scheduleDraft&&!h.hooks.result.isSaving&&noSuccess(h),"Incomplete availability readback cannot announce success");h.hooks.unmount();
}
{
 const h=await settingsHarness(env=>{env.rows.doctor_personal_information=null;});edit(h,"personal","nationality","New Personal Record");await saveCard(h,"personal");
 check(h.rows.doctor_personal_information.years_of_experience===null&&h.hooks.result.settings.yearsExperience==="","New personal record preserves unknown experience instead of database default zero");
 check(h.writes.find(w=>w.table==="doctor_personal_information").action==="insert","New personal record uses insert so defaults cannot overwrite concurrent saved data");
 edit(h,"personal","nationality","Updated Personal Record");await saveCard(h,"personal");
 check(!Object.hasOwn(h.writes.filter(w=>w.table==="doctor_personal_information")[1].payload,"years_of_experience"),"Later scoped personal updates do not write unrelated experience");h.hooks.unmount();
}
// Exercise rendered JSX controls, not direct save helpers. Form association is
// resolved from the rendered tree so this also covers native implicit submission.
const isolationStart = checks;
function renderedNodes(node, ancestors = []) {
 if(Array.isArray(node))return node.flatMap(child=>renderedNodes(child,ancestors));
 if(!node || typeof node!=="object" || !node.props)return [];
 return [{node,ancestors},...renderedNodes(node.props.children,[...ancestors,node])];
}
const renderedCard = (h,section) => renderedNodes(h.hooks.result.renderTree()).find(({node})=>node.props.className?.split(" ").includes("doctor-settings-info-card--"+section)).node;
const renderedInput = (h,section,label) => {
 const item=renderedNodes(renderedCard(h,section)).find(({node})=>node.type==="label"&&node.props.children[0]?.props.children===label).node;
 return renderedNodes(item).find(({node})=>["input","select"].includes(node.type)).node;
};
async function renderedClick(h,{node:button,ancestors}) {
 if(button.props.disabled)return;
 let prevented=false;
 const event={preventDefault(){prevented=true;},currentTarget:button,target:button};
 const pending=button.props.onClick?.(event);
 // Browser default activation submits only buttons of submit type (including
 // the default type) and associates them with their nearest ancestor form.
 if(!prevented && (button.props.type||"submit")==="submit"){
  const form=ancestors.findLast(node=>node.type==="form");
  if(form)await form.props.onSubmit({preventDefault(){},currentTarget:form,target:form,nativeEvent:{submitter:button}});
 }
 await pending;await settle(h.hooks);
}
const renderedToggle = (h,section) => renderedClick(h,renderedNodes(h.hooks.result.renderTree()).find(({node,ancestors})=>node.type==="button"&&ancestors.some(parent=>parent.props.className?.split(" ").includes("doctor-settings-info-card--"+section))));
const renderedEdit = (h,section,label,value) => {renderedInput(h,section,label).props.onChange({target:{value}});h.hooks.flush();};
async function renderedCardSubmit(h,section,label) {
 const entries=renderedNodes(h.hooks.result.renderTree());
 const item=entries.find(({node,ancestors})=>node.type==="label"&&node.props.children[0]?.props.children===label&&ancestors.some(parent=>parent.props.className?.split(" ").includes("doctor-settings-info-card--"+section)));
 const form=item.ancestors.findLast(node=>node.type==="form");
 check(Boolean(form),"Editable "+section+" field belongs to a form");
 await form.props.onSubmit({preventDefault(){},target:form,currentTarget:form,nativeEvent:{submitter:null}});await settle(h.hooks);
}
for(const saveVia of ["Done","form submission"]){
 const h=await settingsHarness();
 const professionalValue="UNSAVED PROFESSIONAL - "+saveVia,personalValue="SAVED PERSONAL - "+saveVia;
 await renderedToggle(h,"professional");renderedEdit(h,"professional","Clinic/Hospital Name",professionalValue);
 check(h.writes.length===0&&h.hooks.result.editingProfileCards.professional,"Professional Edit and typing do not save");
 await renderedToggle(h,"personal");
 check(h.writes.length===0&&h.hooks.result.editingProfileCards.professional&&h.hooks.result.editingProfileCards.personal,"Personal Edit keeps both cards independent without automatic saving");
 renderedEdit(h,"personal","Full Name",personalValue);
 if(saveVia==="Done")await renderedToggle(h,"personal");else await renderedCardSubmit(h,"personal","Full Name");
 check(h.rows.doctor_personal_information.full_name===personalValue,"Rendered Personal "+saveVia+" saves Personal information");
 check(!h.writes.some(w=>w.table==="doctor_professional_information"),"Rendered Personal "+saveVia+" causes no Professional mutation");
 check(h.hooks.result.getDraftValue("professional","clinicName")===professionalValue&&h.hooks.result.editingProfileCards.professional,"Unsaved Professional draft remains editable after Personal "+saveVia);
 const savedRows=structuredClone(h.rows);
 // A fresh component reads only simulated authoritative persisted rows, with
 // no retained draft state, matching a full page reload without live DB writes.
 const reloaded=await settingsHarness(env=>{env.rows=structuredClone(savedRows);});
 check(reloaded.hooks.result.settings.displayName===personalValue&&reloaded.hooks.result.settings.clinicName==="Original Clinic","Fresh authoritative reload contains saved Personal and excludes unsaved Professional: "+saveVia);reloaded.hooks.unmount();
 await renderedToggle(h,"professional");
 check(h.rows.doctor_professional_information.clinic_hospital_name===professionalValue&&h.writes.filter(w=>w.table==="doctor_professional_information").length===1,"Explicit rendered Professional Done persists its draft exactly once: "+saveVia);
 const afterDone=await settingsHarness(env=>{env.rows=structuredClone(h.rows);});
 check(afterDone.hooks.result.settings.clinicName===professionalValue,"Explicit Professional save survives authoritative reload: "+saveVia);afterDone.hooks.unmount();h.hooks.unmount();
}
{
 const h=await settingsHarness();
 await renderedToggle(h,"personal");renderedEdit(h,"personal","Nationality","UNSAVED PERSONAL NATIONALITY");
 await renderedToggle(h,"professional");renderedEdit(h,"professional","Clinic/Hospital Name","SAVED PROFESSIONAL CLINIC");await renderedToggle(h,"professional");
 check(!h.writes.some(w=>w.table==="doctor_personal_information"),"Rendered Professional Done does not write an unsaved Personal draft");
 check(h.hooks.result.getDraftValue("personal","nationality")==="UNSAVED PERSONAL NATIONALITY"&&h.hooks.result.editingProfileCards.personal,"Personal draft remains independently editable after Professional Done");
 const reloaded=await settingsHarness(env=>{env.rows=structuredClone(h.rows);});
 check(reloaded.hooks.result.settings.clinicName==="SAVED PROFESSIONAL CLINIC"&&reloaded.hooks.result.settings.nationality==="","Professional-only save excludes unsaved Personal value after fresh authoritative reload");reloaded.hooks.unmount();h.hooks.unmount();
}
{
 const h=await settingsHarness();await renderedToggle(h,"professional");renderedEdit(h,"professional","Clinic/Hospital Name","UNSAVED PROFILE CLINIC");await renderedToggle(h,"personal");renderedEdit(h,"personal","Full Name","UNSAVED PROFILE NAME");
 h.hooks.result.setActivePanel("account");h.hooks.flush();
 const tree=renderedNodes(h.hooks.result.renderTree());
 const contact=tree.find(({node})=>node.type==="input"&&node.props.value==="original-contact").node;contact.props.onChange({target:{value:"SAVED ACCOUNT CONTACT"}});h.hooks.flush();
 const button=renderedNodes(h.hooks.result.renderTree()).find(({node,ancestors})=>node.type==="button"&&node.props.type==="submit"&&ancestors.some(parent=>parent.props.className==="doctor-settings-account-form"));
 await renderedClick(h,button);
 check(h.rows.doctor_professional_information.contact_number==="SAVED ACCOUNT CONTACT"&&h.rows.profiles.contact_number==="SAVED ACCOUNT CONTACT","Rendered Account submit persists only its intended fields with required synchronization");
 check(!h.writes.some(w=>w.table==="doctor_personal_information")&&h.rows.doctor_professional_information.clinic_hospital_name==="Original Clinic","Rendered Account Save never writes either Profile draft");
 const reloaded=await settingsHarness(env=>{env.rows=structuredClone(h.rows);});
 check(reloaded.hooks.result.settings.displayName==="Doctor A"&&reloaded.hooks.result.settings.clinicName==="Original Clinic"&&reloaded.hooks.result.settings.contactNumber==="SAVED ACCOUNT CONTACT","Account-only save and draft isolation survive authoritative reload");reloaded.hooks.unmount();h.hooks.unmount();
}
{
 const h=await settingsHarness();const tree=renderedNodes(h.hooks.result.renderTree());
 const cards=tree.filter(({node})=>node.props.className?.includes("doctor-settings-info-card--"));
 check(cards.length===2&&cards.every(({node,ancestors})=>node.type==="form"&&!ancestors.some(parent=>parent.type==="form")),"Profile cards have independent sibling forms without nested or shared form submission");
 const footer=tree.find(({node,ancestors})=>node.type==="button"&&ancestors.some(parent=>parent.props.className==="doctor-settings-footer"));
 check(footer.node.props.type==="button"&&!footer.ancestors.some(parent=>parent.type==="form"),"Bulk Profile footer requires an explicit click and cannot receive an implicit card submit");h.hooks.unmount();
}
console.log("Rendered draft isolation verification passed: "+(checks-isolationStart)+" assertions.");
console.log("Batch 1 security assertions preserved: "+batch1Checks+"; Batch 2 reliability assertions: "+(checks-batch1Checks)+".");
console.log("Doctor Profile & Settings security and reliability verification passed: "+checks+" assertions.");
console.log("Production handlers/helpers and installed SDK exercised with mocked Auth, queries and timers; no live Supabase/browser verification.");
