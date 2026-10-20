// Actual filtering callbacks and shared control, synthetic records only. No application client imported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { parse } from 'espree';
import { transformWithOxc } from 'vite';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import * as dates from '../src/lib/appointmentDate.js';
import * as range from '../src/lib/appointmentDateRange.js';
if(!vm.SourceTextModule){const r=spawnSync(process.execPath,['--experimental-vm-modules',...process.argv.slice(1)],{stdio:'inherit',windowsHide:true});process.exit(r.status??1);}
let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
const equal=(a,b,m)=>{assert.deepEqual(JSON.parse(JSON.stringify(a)),b,m);checks++;};
const read=p=>fs.readFileSync(p,'utf8');
const parseJs=s=>parse(s,{sourceType:'module',ecmaVersion:'latest',ecmaFeatures:{jsx:true},range:true});
function find(n,p){if(!n||typeof n!=='object')return null;if(p(n))return n;for(const v of Object.values(n))for(const c of Array.isArray(v)?v:[v]){const r=find(c,p);if(r)return r;}return null;}
const evaluate=(source,context={})=>vm.runInNewContext('('+source+')',context);
const empty={from:'',to:''},sameDay={from:'2026-10-20',to:'2026-10-20'};
for(const [date,valid]of [['2024-02-29',true],['2026-02-29',false],['2026-02-30',false],['1900-02-29',false],['2000-02-29',true],['0000-01-01',false],['2026-13-01',false],['2026-10-00',false],['2026-1-2',false],['invalid',false]])equal(range.isValidCalendarDate(date),valid,'Real calendar date: '+date);
check(range.getAppointmentDateRangeError({from:'2026-10-21',to:'2026-10-20'}).includes('on or after'),'Reversed range has clear error');
check(Boolean(range.getAppointmentDateRangeError({from:'2026-02-30',to:''})),'Impossible date rejected');
equal(range.getAppointmentDateRangeError(sameDay),'','Same-day range valid');
for(const value of [null,undefined,'','invalid','2026-10-20'])equal(range.matchesAppointmentDateRange(value,empty),true,'All dates preserves undated/legacy rows');
for(const value of [null,undefined,'','invalid','2026-02-30'])equal(range.matchesAppointmentDateRange(value,sameDay),false,'Bounded range never invents dates');
for(const [value,expected]of [['2026-10-19T15:59:59Z',false],['2026-10-19T16:00:00Z',true],['2026-10-20T15:59:59.999Z',true],['2026-10-20T16:00:00Z',false],['2026-10-20T23:59:00+08:00',true],['2026-10-20',true]])equal(range.matchesAppointmentDateRange(value,sameDay),expected,'Manila inclusive boundary '+value);
equal(range.matchesAppointmentDateRange('2026-10-21',{from:'2026-10-20',to:''}),true,'Start only includes later dates');
equal(range.matchesAppointmentDateRange('2026-10-19',{from:'',to:'2026-10-20'}),true,'End only includes earlier dates');
equal(range.matchesAppointmentDateRange('2026-10-20',{from:'2026-10-21',to:'2026-10-20'}),false,'Invalid range fails closed');
for(const timezone of ['Asia/Manila','UTC','America/New_York']){
 const code=`import {matchesAppointmentDateRange as match} from './src/lib/appointmentDateRange.js';console.log(JSON.stringify(['2026-10-19T15:59:59Z','2026-10-19T16:00:00Z','2026-10-20T15:59:59Z','2026-10-20T16:00:00Z'].map(v=>match(v,${JSON.stringify(sameDay)}))));`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',env:{...process.env,TZ:timezone},windowsHide:true});equal(r.status,0,'Timezone child executes');equal(JSON.parse(r.stdout),[false,true,true,false],timezone+': stable date membership');
}
const sources={};
for(const role of ['staff','doctor']){
 const file=`src/pages/${role}/${role==='staff'?'Staff':'Doctor'}_Appointments.jsx`,source=read(file),ast=parseJs(source);sources[role]={file,source,ast};
 const variable=name=>{const n=find(ast,n=>n.type==='VariableDeclarator'&&n.id.name===name);assert.ok(n,name);return n;};
 const callback=name=>source.slice(...variable(name).init.arguments[0].range);
 const functions=role==='staff'?['appointmentStatusMatches']:['statusMatches','searchMatches'];
 const helpers=Object.fromEntries(functions.map(name=>{const n=find(ast,n=>n.type==='FunctionDeclaration'&&n.id.name===name);return [name,evaluate(source.slice(...n.range),dates)];}));
 const rows=['scheduled','checked_in','completed','cancelled','no_show'].flatMap((status,i)=>[-1,0,1].map(offset=>{
  const day=String(20+offset),start=`2026-10-${day}T09:00:00+08:00`;
  return {id:`${status}-${offset}`,start_time:start,startTime:start,status,databaseStatus:status,patient_name:'Synthetic Match',name:'Synthetic Match',patient_id:'synthetic-id',patientId:'synthetic-id',appointmentId:`MA-${i}-${offset}`,title:'Prenatal',description:'',doctor_name:'Synthetic Doctor'};
 }));
 rows.push({id:'undated',status:'scheduled',databaseStatus:'scheduled',name:'Undated',patient_name:'Undated'});
 const makeContext=(tab,dateRange=empty,search='')=>({...dates,...range,...helpers,appointments:rows,schedules:rows,activeFilter:tab,activeTab:tab,dateRange,searchQuery:search,searchTerm:search,dashboardTodayTarget:false});
 const filteredName=role==='staff'?'filteredAppointments':'visibleSchedules';
 const filter=(context)=>evaluate(callback(filteredName),context)();
 for(const tab of ['All','Pending','Checked-in','Completed','Cancelled','Missed']){
  equal(filter(makeContext(tab,sameDay)).length,tab==='All'?5:1,role+': inclusive date filter in '+tab);
  equal(filter(makeContext(tab,sameDay,'does-not-match')).length,0,role+': search and range intersect in '+tab);
  equal(filter(makeContext(tab,sameDay,'synthetic')).length,tab==='All'?5:1,role+': matching search preserved in '+tab);
 }
 equal(filter(makeContext('All')).length,16,role+': Clear restores all rows including undated');
 equal(filter(makeContext('All',{from:'2026-10-20',to:''})).length,10,role+': open start across tabs');
 equal(filter(makeContext('All',{from:'',to:'2026-10-20'})).length,10,role+': open end across tabs');
 const context=makeContext('All',sameDay);
 if(role==='staff'){
  const suggestion=evaluate(callback('searchSuggestions'),{...context,searchQuery:'synthetic'})();
  equal(suggestion.length,5,'Staff suggestions honor applied date range');
  const requests=[{id:'a',status:'pending',start_time:'2026-10-20T00:00:00+08:00',created_at:'2026-10-19T00:00:00Z',patient_name:'Synthetic'},
   {id:'b',status:'pending',start_time:'2026-10-21T00:00:00+08:00',created_at:'2026-10-18T00:00:00Z',patient_name:'Synthetic'},
   {id:'c',status:'accepted',start_time:'2026-10-20T00:00:00+08:00',created_at:'2026-10-19T00:00:00Z'},
   {id:'d',status:'pending',created_at:'2026-10-20T00:00:00Z',patient_name:'Synthetic'}];
  const requestContext={bookingRequests:requests,requestSort:'newest',searchQuery:'',dateRange:sameDay,...range,getRequestId:r=>r.id};
  equal(evaluate(callback('requestSchedules'),requestContext)().map(r=>r.id),['a'],'Requests filter preferred date, never creation date');
  equal(evaluate(callback('requestSchedules'),{...requestContext,dateRange:empty})().map(r=>r.id),['d','a','b'],'Requests clear preserves pending-only and creation-time ordering');
  equal(evaluate(callback('requestSchedules'),{...requestContext,searchQuery:'absent'})().length,0,'Requests range works with search');
  const requestPage=evaluate(callback('paginatedRequests'),{requestDisplayedPage:2,requestSchedules:Array.from({length:12},(_,i)=>i)})();equal(requestPage,[5,6,7,8,9],'Requests retain original five-row pagination');
 }
 // Actual Apply handler resets page immediately. Neither draft edits nor invalid input reach it.
 const updates=[];const apply=evaluate(source.slice(...variable('applyDateRange').init.range),{setDateRange:value=>updates.push(['range',value]),setCurrentPage:page=>updates.push(['page',page])});apply(sameDay);
 equal(updates,[['range',sameDay],['page',1]],role+': Apply resets page without transport');
 for(const count of [0,1,10,11,15,16,37])for(const limit of [10,15]) {
  const list=Array.from({length:count},(_,i)=>({id:String(i)}));
  const total=vm.runInNewContext(source.slice(...variable('totalPages').init.range),{filteredAppointments:list,visibleSchedules:list,pageSize:limit});
  equal(total,Math.max(1,Math.ceil(count/limit)),role+': actual total page count for '+count+'/'+limit);
 }
 const pageFn=callback(role==='staff'?'paginatedAppointments':'paginatedSchedules');
 const filtered=Array.from({length:37},(_,i)=>({id:String(i)}));
 for(const pageSize of [10,15]){
  const totalPages=Math.ceil(filtered.length/pageSize),seen=[];
  for(let currentPage=1;currentPage<=totalPages;currentPage++){
   const result=evaluate(pageFn,{currentPage,displayedPage:currentPage,pageSize,filteredAppointments:filtered,visibleSchedules:filtered})();
   equal(result.length,Math.min(pageSize,37-(currentPage-1)*pageSize),role+': last partial page for '+pageSize);seen.push(...result.map(r=>r.id));
  }
  equal(seen,filtered.map(r=>r.id),role+': page slicing keeps every filtered ID exactly once');
 }
 check(source.includes('value={dateRange}')&&source.includes('onApply={applyDateRange}'),role+': shared filter is wired to applied state');
 check(!/Filter by Month|type="month"|monthFilterMatches/.test(source),role+': old month control removed');
 // All table filters remain local: transport/RPC callbacks and other top-level helpers must match task-start copies.
 if(process.argv[2]){
  const original=read(path.join(process.argv[2],path.basename(file))),before=parseJs(original);
  const compact=s=>s.replaceAll('\r\n','\n');
  const protectedNames=[];
  function collect(n){if(!n||typeof n!=='object')return;if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init){const text=original.slice(...n.init.range);if(/supabase\.|requestAppointmentSms\(|sendAutomaticAppointmentNotification\(/.test(text)&&!text.includes('<'))protectedNames.push(n.id.name);}for(const v of Object.values(n))for(const c of Array.isArray(v)?v:[v])collect(c);}
  collect(before);
  for(const name of new Set(protectedNames)){
   const a=find(before,n=>n.type==='VariableDeclarator'&&n.id.name===name),b=find(ast,n=>n.type==='VariableDeclarator'&&n.id.name===name);
   equal(compact(source.slice(...b.init.range)),compact(original.slice(...a.init.range)),role+': unchanged operational callback '+name);
  }
 }
}
// Execute the production shared control with deterministic hooks, DOM events and synthetic props.
const slots=[],effects=[],listeners=new Map();let cursor=0,dirty=false,focuses=0;const refs=[];
const react={useId:()=> 'range-test',useRef(){const i=cursor++;if(!slots[i]){slots[i]={current:null};refs.push(slots[i]);}return slots[i];},
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;dirty=true;}];},
 useEffect(fn,deps){const i=cursor++;if(!slots[i]||!deps.every((d,n)=>Object.is(d,slots[i].deps[n]))){effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});}}
};
const context=vm.createContext({document:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}});
async function moduleFor(file){const code=(await transformWithOxc(read(file),file,{jsx:{runtime:'automatic',development:false}})).code;const m=new vm.SourceTextModule(code,{context});await m.link(async spec=>{
 let exports;if(spec==='react')exports=react;else if(spec==='react/jsx-runtime')exports=jsx;else if(spec==='lucide-react')exports=Object.fromEntries(['CalendarDays','ChevronDown','X'].map(n=>[n,()=>null]));
 else if(spec.endsWith('appointmentDateRange'))exports=range;else if(spec==='./AppointmentUi')return moduleFor('src/components/appointments/AppointmentUi.jsx');else if(spec.endsWith('.css'))exports={};else throw Error('Unexpected dependency '+spec);
 return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});});await m.evaluate();return m;}
const ui=(await moduleFor('src/components/appointments/AppointmentDateRangeFilter.jsx')).namespace;let applied=empty;const receipts=[];
const render=()=>{let result;for(let n=0;n<8;n++){cursor=0;dirty=false;result=ui.default({value:applied,onApply:value=>{applied=value;receipts.push(value);}});for(const fn of effects.splice(0))fn();if(!dirty)return result;}throw Error('Unexpected render loop');};
const expand=n=>Array.isArray(n)?n.map(expand):!n||typeof n!=='object'?n:typeof n.type==='function'?expand(n.type(n.props)):{...n,props:{...n.props,children:expand(n.props?.children)}};
const nodes=(n,p)=>Array.isArray(n)?n.flatMap(x=>nodes(x,p)):!n||typeof n!=='object'?[]:[...(p(n)?[n]:[]),...nodes(n.props?.children,p)];
const tree=()=>expand(render());const text=n=>Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):String(n??'');
const button=label=>nodes(tree(),n=>n.type==='button'&&(n.props['aria-label']===label||text(n)===label))[0];
const trigger=()=>nodes(tree(),n=>n.type==='button'&&n.props['aria-haspopup']==='dialog')[0];
const input=label=>nodes(tree(),n=>n.type==='input'&&n.props.id===`range-test-${label}`)[0];
render();refs[0].current={contains:target=>target?.inside};refs[1].current={focus:()=>focuses++};refs[2].current={focus:()=>focuses++};
check(text(trigger()).includes('All dates'),'Default summary is All dates');
trigger().props.onClick();tree();check(focuses>0,'Opening focuses From input');check(nodes(tree(),n=>n.props.role==='dialog').length===1,'One accessible popup rendered');
input('from').props.onChange({target:{value:'2026-10-21'}});input('to').props.onChange({target:{value:'2026-10-20'}});equal(receipts.length,0,'Draft editing does not filter');button('Apply Range').props.onClick();check(nodes(tree(),n=>n.props.role==='alert').length===1,'Invalid range keeps dialog open with error');equal(receipts.length,0,'Invalid range does not apply or reset pages');
input('from').props.onChange({target:{value:'2026-10-20'}});button('Apply Range').props.onClick();equal(applied,sameDay,'Apply commits validated same-day range');check(!trigger().props['aria-expanded'],'Apply closes popup');
trigger().props.onClick();input('to').props.onChange({target:{value:'2026-10-25'}});listeners.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});tree();equal(receipts.length,1,'Escape discards draft');
trigger().props.onClick();equal(input('to').props.value,'2026-10-20','Reopening restores applied dates');listeners.get('pointerdown')({target:{inside:false}});tree();equal(receipts.length,1,'Outside click does not apply');
trigger().props.onClick();button('Clear').props.onClick();tree();equal(applied,empty,'Clear restores All dates');check(focuses>=3,'Apply/Escape/Clear return focus');equal(listeners.size,0,'Closed popup cleans up document listeners');
for(const oneSided of [{from:'2026-10-20',to:''},{from:'',to:'2026-10-20'}]){trigger().props.onClick();input('from').props.onChange({target:{value:oneSided.from}});input('to').props.onChange({target:{value:oneSided.to}});button('Apply Range').props.onClick();tree();equal(applied,oneSided,'UI supports one-sided range');}
const html=renderToStaticMarkup(render());check(html.includes('Filter by Date Range'),'Visible filter label retained');
const css=postcss.parse(read('src/styles/appointment-date-range.css'));const rules=[];css.walkRules(r=>rules.push(r));
const popover=rules.find(r=>r.selector==='.appointment-date-range__popover');check(popover.nodes.some(n=>n.prop==='position'&&n.value==='absolute'),'Popover does not shift toolbar layout');check(popover.nodes.some(n=>n.prop==='width'&&n.value==='100%'),'Popover fits existing control width');check(popover.nodes.some(n=>n.prop==='overflow'&&n.value==='auto'),'Popover supports shorter viewports');
check(rules.some(r=>r.parent.type==='atrule'&&r.parent.params==='(max-width: 760px)'&&r.selector.includes('appointment-date-range-request')),'Requests control stacks on mobile');
console.log(`PASS: ${checks} appointment date-range assertions. Actual callbacks/control, timezone subprocesses and CSS contracts; no live operations or browser geometry tests.`);
