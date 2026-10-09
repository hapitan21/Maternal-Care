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
        if(action!=="select")writes.push({table,action,payload,filter,token});
        if(env.writeGate && table===env.writeGateTable && action!=="select")await env.writeGate.promise;
        return {data:action==="select"?(table==="profiles"?{avatar_url:"original-avatar"}:[]):{id:"synthetic",auth_user_id:"doctor-a"},error:env.fail};
      };
      const db={ from(table){let action="select",payload,filter;const q={select(){return q;},order(){return q;},eq(column,value){filter={column,value};return q;},upsert(value){action="upsert";payload=value;return q;},update(value){action="update";payload=value;return q;},single(){return q;},maybeSingle(){return q;},then(resolve,reject){return request(table,action,payload,filter).then(resolve,reject);}};return q;},
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
const exposed=settingsSource.replace('  return (\n    <section className="doctor-settings-page"', '  return { settings, changeEmailState, changePasswordOtp, isSaving, isLoading, toast, message, updateSetting, setPasswordForm, changeEmail, requestEmailChangeOtp, verifyEmailChangeOtp, resendEmailChangeOtp, setChangeEmailField, handlePasswordSubmit, setChangePasswordOtpField, verifyPasswordOtpAndUpdate, saveProfileSettings, saveAccountSettings, toggleProfileCardEdit, closeChangeEmailModal };\n  return (\n    <section className="doctor-settings-page"');
check(exposed!==settingsSource,"Harness exercises production Settings handlers and effects");
const password=await import("../src/lib/passwordSecurity.js");
const availability=await import("../src/lib/availabilitySchedule.js");
async function settingsHarness() {
  const env=environment(),hooks=hookRuntime();let logout=0;
  const identity={authUser:session().user,profile:{id:"doctor-a",role:"doctor",account_status:"active"},doctorDisplayName:"Doctor A",personalInformation:{full_name:"Doctor A"},professionalInformation:{}};
  env.loadGate=null;
  const ctx=vm.createContext({console,window:env.window,Event,URL,AbortController});
  const scopedSecurity={...security,createAuthenticatedMutation:(client,options)=>{factory=env.factory;return security.createAuthenticatedMutation(client,{...options,setTimer:env.window.setTimeout,clearTimer:env.window.clearTimeout});}};
  const react={...hooks.runtime};react.default=react;
  const mod=await evaluate(exposed,"settings.jsx",{
    react,"react/jsx-runtime":jsx,"../../context/roleInactivityContext":{DoctorSignOutContext:{value:()=>{logout++;return Promise.resolve();}}},
    "../../lib/authenticatedMutation":scopedSecurity,"../../lib/roleInactivity":role,
    "../../lib/supabaseClient":{supabase:env.client},"../../hooks/useAuthenticatedDoctor":{loadAuthenticatedDoctor:async user=>{if(env.loadGate)await env.loadGate.promise;return {...identity,authUser:user};}},
    "../../lib/passwordSecurity":password,"../../lib/availabilitySchedule":availability,"../../components/common/PasswordSecurityFeedback":{default:"Feedback"},
  },ctx);
  hooks.mount(mod.default,{doctorIdentity:identity});await settle(hooks);
  check(!hooks.result.isLoading,"Doctor Settings initial data loaded in mock");
  env.hooks=hooks;env.logout=()=>logout;
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
 h.hooks.result.updateSetting("displayName","Pending Doctor A");h.hooks.flush();
 if(kind==="card"){h.hooks.result.toggleProfileCardEdit("personal");h.hooks.flush();}
 if(boundary==="identity")h.loadGate=deferred();else{h.writeGate=deferred();h.writeGateTable="doctor_personal_information";}
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
 const h=await settingsHarness();h.writeGate=deferred();h.writeGateTable="doctor_personal_information";
 const pending=h.hooks.result.saveProfileSettings({preventDefault(){}});await settle(h.hooks);
 if(abandon==="logout")h.emit("SIGNED_OUT",null);else h.hooks.unmount();
 h.writeGate.resolve();await pending;await settle(abandon==="unmount"?null:h.hooks);
 check(!h.writes.some(w=>w.table==="profiles"||w.table==="sync_current_profile_email")&&!h.notices.length,"Pending profile write has no follow-up after "+abandon);
 if(abandon!=="unmount")h.hooks.unmount();
}
{
 const h=await settingsHarness();h.writeGate=deferred();h.writeGateTable="doctor_personal_information";
 const a=h.hooks.result.saveAccountSettings({preventDefault(){}}),b=h.hooks.result.saveAccountSettings({preventDefault(){}});await settle(h.hooks);
 check(h.writes.filter(w=>w.table==="doctor_personal_information").length===1,"Duplicate account save has one write sequence");h.writeGate.resolve();await Promise.all([a,b]);await settle(h.hooks);h.hooks.unmount();
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
console.log("Doctor Profile & Settings security verification passed: "+checks+" assertions.");
console.log("Production handlers/helpers and installed SDK exercised with mocked Auth, queries and timers; no live Supabase/browser verification.");
