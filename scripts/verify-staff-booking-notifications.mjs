// Offline production-controller tests. No live Supabase reads or mutations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { parse } from 'espree';
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], {stdio:'inherit',windowsHide:true});
  if (result.error) throw result.error; process.exit(result.status ?? 1);
}
const root = new URL('../',import.meta.url);
const source = await readFile(new URL('src/lib/staffBookingRequestNotifications.js',root),'utf8');
const role = await readFile(new URL('src/lib/roleInactivity.js',root),'utf8');
const node = parse(role,{ecmaVersion:'latest',sourceType:'module',range:true}).body.find(node=>node.declaration?.id?.name==='getLogicalSessionIdentity');
const context = vm.createContext({AbortController,Date,Map,Set,WeakMap,Promise,setTimeout,clearTimeout,setInterval,clearInterval,atob});
const dependency = new vm.SourceTextModule(role.slice(...node.range),{context});
const module = new vm.SourceTextModule(source,{context});await module.link(()=>dependency);await module.evaluate();
const {createStaffBookingRequestNotifications:create} = module.namespace;
let assertions=0;
const check=(ok,message)=>{assert.ok(ok,message);assertions++};
const tick=()=>new Promise(resolve=>setTimeout(resolve,8));
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
const session=(user='staff-a',id='one')=>({user:{id:user},access_token:'x.'+Buffer.from(JSON.stringify({session_id:id})).toString('base64')+'.x'});
function fixture(options={}){
  const auth=new Set(),windowTarget=new EventTarget(),documentTarget=new EventTarget();documentTarget.visibilityState='visible';
  const state={count:3,time:100000,heads:[],channels:[],snapshots:[],removed:[],session:session(),repeaters:new Set(),...options};
  const client={auth:{getSession:()=>state.rejectAuth?Promise.reject(new Error('Offline auth lookup')):state.authGate?.promise||Promise.resolve({data:{session:state.session},error:state.authError}),onAuthStateChange(fn){auth.add(fn);return{data:{subscription:{unsubscribe(){auth.delete(fn)}}}}}},
    from(table){const request={table};state.heads.push(request);const query={select(columns,options){Object.assign(request,{columns,options});return query},eq(column,value){request.filter=[column,value];return query},abortSignal(signal){request.signal=signal;return query},then(resolve,reject){
      if(state.headGate){const pending=state.headGate;state.headGate=null;return pending.promise.then(resolve,reject)}
      if(state.rejectCount)return Promise.reject(new Error('Offline failure')).then(resolve,reject);
      return Promise.resolve({count:state.count,error:state.countError}).then(resolve,reject)}};return query},
    channel(name){if(state.throwChannel)throw new Error('Realtime unavailable');const channel={name,on(type,filter,fn){Object.assign(channel,{type,filter,event:fn});return channel},subscribe(fn){channel.status=fn;if(!state.holdSubscription)fn('SUBSCRIBED');return channel}};state.channels.push(channel);return channel},
    removeChannel(channel){state.removed.push(channel);return Promise.resolve('ok')},
  };
  const parameters={client,userId:'staff-a',now:()=>state.time,onChange:value=>state.snapshots.push(value),windowTarget,documentTarget,
    setRepeater(fn){state.repeaters.add(fn);return fn},clearRepeater(fn){state.repeaters.delete(fn)}};
  let controller=create(parameters);
  return{state,client,windowTarget,documentTarget,auth,get controller(){return controller},last:()=>state.snapshots.at(-1),
    emitSession(next){state.session=next;for(const fn of auth)fn(next?'SIGNED_IN':'SIGNED_OUT',next)},
    event(eventType='INSERT',id='new',status='pending',created=100001){state.channels.at(-1).event({eventType,new:{id,status,created_at:new Date(created).toISOString(),patient_name:'PRIVATE PATIENT',description:'PRIVATE MEDICAL FIELD'}})},
    remount(){controller.dispose();controller=create(parameters)},
  };
}
{
  const f=fixture({count:3500});await tick();
  check(f.last().count===3500,'Exact count includes more rows than the server page cap');
  check(f.state.heads.length===1,'Startup performs one coalesced count read');
  const query=f.state.heads[0];
  check(query.table==='create_patient_appointment_request'&&query.columns==='id'&&query.options.count==='exact'&&query.options.head,'Uses authoritative count-only authorized request query');
  check(query.filter.join('|')==='status|pending','Regular Pending schedule appointments never contribute');
  check(!f.last().toast,'Historical initial count never creates toast');
  check(f.state.channels.length===1&&f.state.channels[0].filter.table===query.table,'One request channel per Staff shell');
  f.state.count=3501;f.event();await tick();
  check(f.last().count===3501&&f.last().toast?.id==='new','New pending insert updates authoritative count and creates notification');
  check(!JSON.stringify(f.last()).includes('PRIVATE'),'Notification state exposes no patient/medical details');
  f.controller.dismissToast();f.event();await tick();check(!f.last().toast,'Repeated insert ID cannot recreate dismissed toast');
  f.state.channels[0].status('CHANNEL_ERROR');await tick();check(f.last().realtime==='unavailable','Returned channel error never claims subscription success');
  f.state.channels[0].status('SUBSCRIBED');f.event();await tick();check(!f.last().toast,'Reconnect replay remains deduplicated');
  f.event('INSERT','historical','pending',99999);await tick();check(!f.last().toast,'Historical insertion timestamp is silent');
  f.event('INSERT','accepted','accepted');await tick();check(!f.last().toast,'Accepted insert is not a new outstanding request notification');
  for(const status of ['accepted','declined']){
    f.state.count--;f.event('UPDATE',status,status);await tick();check(f.last().count===f.state.count&&!f.last().toast,status+': authoritative review decreases count without toast');
  }
  f.state.count=0;await f.controller.refresh();check(f.last().count===0,'Valid zero count preserved');
  const reads=f.state.heads.length;f.emitSession(session());await tick();check(f.state.channels.length===1&&f.state.heads.length===reads,'Same-session Auth object refresh keeps one channel and avoids reads');
  f.windowTarget.dispatchEvent(new Event('focus'));f.documentTarget.dispatchEvent(new Event('visibilitychange'));await tick();
  check(f.state.heads.length===reads+1&&!f.last().toast,'Focus/visibility coalesce one refresh and never replay toast');
  f.remount();await tick();f.event();await tick();check(!f.last().toast,'Same-session shell remount retains replay ledger');
  f.controller.dispose();check(f.auth.size===0&&f.state.repeaters.size===0,'Unmount removes auth and fallback listeners');
  check(f.state.removed.length===2,'Unmount removes each owned channel');
}
for(const kind of ['returned','thrown','missing-count']){
  const f=fixture();await tick();
  if(kind==='returned')f.state.countError={message:'network'};if(kind==='thrown')f.state.rejectCount=true;if(kind==='missing-count')f.state.count=null;
  const result=await f.controller.refresh();check(!result.ok&&f.last().count===3&&!!f.last().error,kind+': unavailable refresh keeps truthful last-good count with error');
  f.state.countError=null;f.state.rejectCount=false;f.state.count=4;await f.controller.retry();
  check(f.last().count===4&&!f.last().error,kind+': Retry restores authoritative count');f.controller.dispose();
}
{
  const f=fixture({countError:{code:'42501'}});await tick();check(f.last().count===null&&!!f.last().error,'Denied initial read never invents zero');
  f.state.countError=null;await f.controller.retry();check(f.last().count===3,'Denied query can recover via Retry');
  f.state.countError={code:'42501'};await f.controller.refresh();check(f.last().count===null,'Explicit access denial removes old count');f.controller.dispose();
}
{
  const f=fixture({throwChannel:true});await tick();check(f.last().count===3&&f.last().realtime==='unavailable','Synchronous subscription failure retains authorized query fallback');
  f.state.count=4;for(const repeat of f.state.repeaters)repeat();await tick();check(f.last().count===4&&!f.last().toast,'Fallback polling updates count without invented realtime toast');
  const heads=f.state.heads.length;f.documentTarget.visibilityState='hidden';for(const repeat of f.state.repeaters)repeat();await tick();check(f.state.heads.length===heads,'Hidden tab avoids fallback polling');f.controller.dispose();
}
{
  const f=fixture();await tick();const pending=gate();f.state.headGate=pending;const first=f.controller.refresh();await tick();
  f.state.count=8;f.event('INSERT','during-load');await tick();pending.resolve({count:1,error:null});await first;await tick();
  check(f.last().count===8&&!f.state.snapshots.slice(-3).some(item=>item.count===1),'Realtime invalidation fences old count and drains a fresh authoritative query');
  check(f.last().toast?.id==='during-load','In-flight refresh does not duplicate/drop genuinely new notification');f.controller.dispose();
}
for(const change of ['logout','replacement','account','unmount']){
  const f=fixture();await tick();const pending=gate();f.state.headGate=pending;const request=f.controller.refresh();await tick();const old=f.state.channels[0];
  if(change==='logout')f.emitSession(null);if(change==='replacement')f.emitSession(session('staff-a','two'));if(change==='account')f.emitSession(session('staff-b','other'));if(change==='unmount')f.controller.dispose();
  const published=f.state.snapshots.length;old.event({eventType:'INSERT',new:{id:'late',status:'pending',created_at:new Date(100002).toISOString()}});
  pending.resolve({count:999,error:null});await request;await tick();
  check(!f.state.snapshots.slice(published).some(item=>item.count===999||item.toast?.id==='late'),change+': old-session query/event cannot publish');
  check(f.state.heads.find(item=>item.signal?.aborted),change+': pending query aborted');
  if(change!=='replacement')check(!f.last().toast,change+': private notification cleared');
  if(change==='replacement')check(f.state.channels.length===2&&f.last().count===3,'Real session replacement independently subscribes and reloads');
  f.controller.dispose();
}
for(const authOptions of [{authError:{message:'offline'}},{rejectAuth:true}]){
  const f=fixture(authOptions);await tick();check(!!f.last().error&&f.last().count===null&&f.state.channels.length===0,'Returned/rejected authentication keeps unavailable state without protected queries');
  f.state.authError=null;f.state.rejectAuth=false;await f.controller.retry();await tick();check(f.last().count===3,'Authentication lookup has retry recovery');f.controller.dispose();
}
{
  const pending=gate(),f=fixture({authGate:pending});f.emitSession(session('staff-b','other'));pending.resolve({data:{session:session()},error:null});await tick();
  check(f.state.heads.length===0&&f.state.channels.length===0,'Late initial getSession cannot override account replacement');f.controller.dispose();
}
check(!/localStorage|sessionStorage|Notification\.requestPermission|\.rpc\(/.test(source),'No persistent patient information, push permission, or mutation');
{
  const f=fixture();await tick();const heads=f.state.heads.length;f.state.count=2053;
  for(let id=0;id<2050;id++)f.event('INSERT','burst-'+id,'pending',100001+id);
  await tick();check(f.state.heads.length===heads+1&&f.last().count===2053,'Rapid insert burst coalesces one authoritative count query');
  f.controller.dismissToast();f.event('INSERT','burst-0','pending',100001);await tick();check(!f.last().toast,'Evicted ledger ID cannot replay below notification watermark');
  f.event('INSERT','future','pending',103000);await tick();check(f.last().toast?.id==='future','Bounded replay ledger still accepts genuinely newer requests');f.controller.dispose();
}
console.log(`PASS: ${assertions} mocked Staff booking notification assertions.`);
