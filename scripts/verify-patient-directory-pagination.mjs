import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'espree';
import { transformWithOxc } from 'vite';
import * as status from '../src/lib/patientAccountStatus.js';
import { comparePatientRows } from '../src/lib/patientTableSort.js';
import postcss from 'postcss';
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (a, b, message) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), b, message); checks++; };
const read = file => fs.readFileSync(file, 'utf8');
const staff = read('src/pages/staff/Staff_Patients.jsx');
const doctor = read('src/pages/doctor/Doctor_Patients.jsx');
const ast = parse(staff, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    const result = find(child, predicate); if (result) return result;
  }
  return null;
}
const variable = name => staff.slice(...find(ast, n => n.type === 'VariableDeclarator' && n.id?.name === name).range);
const fn = name => staff.slice(...find(ast, n => n.type === 'FunctionDeclaration' && n.id?.name === name).range);
const card = find(ast, n => n.type === 'JSXElement' && n.openingElement.attributes.some(a => a.name?.name === 'className' && a.value?.value === 'staff-patients-card'));
const staffFixture = `${fn('getPatientStatusGroup')} ${fn('formatPatientStatus')} ${fn('getPatientStatusClass')} ${fn('canSendPatientNotification')}
export function StaffFixture({patients}) {
  const [query,setQuery]=useState(''); const [patientStatusFilter,setPatientStatusFilter]=useState('All');
  const [sortConfig,setSortConfig]=useState({key:'name',direction:'asc'});
  const ${variable('filteredPatients')}; const ${variable('pagination')}; const ${variable('paginatedPatients')};
  const ${variable('requestSort')};
  return {table: (${staff.slice(...card.range)}), filteredPatients, pagination, setQuery, setPatientStatusFilter, requestSort};
}`;
function runtime() {
  const slots = []; let cursor, dirty, render;
  const hooks = { ...React, useEffect() {}, useMemo: factory => factory(), useRef: value => ({current:value}),
    useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=typeof initial==='function'?initial():initial;
      return [slots[i], update=>{const next=typeof update==='function'?update(slots[i]):update;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}]; } };
  return { hooks, run(callback) {render=callback;let result;for(let i=0;i<8;i++){cursor=0;dirty=false;result=render();if(!dirty)return result;}throw Error('Render loop');} };
}
async function fixture(role, rows) {
  const rt=runtime(); let props={patients:rows,searchTerm:'',loadState:'loaded',onViewRecord:id=>views.push(id)};
  const views=[]; const blocked=()=>{throw Error('Unexpected live transport');};
  const context=vm.createContext({console, ...status, comparePatientRows, useState:rt.hooks.useState, useMemo:rt.hooks.useMemo,
    dashboardPatientTarget:'', patientActionMenu:null, hasLoadedPatientDirectory:true, isLoadingPatients:false,
    patientLoadError:'',statusMessage:'',setPatientActionMenu(){},togglePatientActionMenu:blocked,
    SendPatientNotificationAction:()=>null,staffPatientNotificationTypes:[], Icon:()=>null});
  const cache=new Map();
  async function load(file, custom) {
    const code=(await transformWithOxc(custom??read(file),file,{jsx:{runtime:'automatic',development:false}})).code;
    const module=new vm.SourceTextModule(code,{context}); cache.set(file,module);
    await module.link(async spec=>{
      let exports;
      if(spec==='react')exports=rt.hooks;
      else if(spec==='react/jsx-runtime')exports=jsx;
      else if(spec==='@iconify/react')exports={Icon:()=>null};
      else if(spec==='react-router-dom')exports={useLocation:()=>({pathname:'/doctor/patients'})};
      else if(spec.endsWith('supabaseClient'))exports={supabase:new Proxy({},{get:()=>blocked})};
      else if(spec.endsWith('doctorSessionCache'))exports={createDoctorSessionCache:()=>new Map()};
      else if(spec.endsWith('useDoctorDelayedLoader'))exports={useDoctorDelayedLoader:()=>false};
      else if(spec.endsWith('.css'))exports={};
      else {const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec))+(spec.endsWith('usePatientTablePagination')||spec.endsWith('patientTableSort')?'.js':'.jsx');
        return cache.get(target)??load(target);}
      return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});
    });await module.evaluate();return module;
  }
  const hook=await load('src/hooks/usePatientTablePagination.js');context.usePatientTablePagination=hook.namespace.usePatientTablePagination;
  const ui=await load('src/components/appointments/AppointmentUi.jsx');context.AppointmentPagination=ui.namespace.AppointmentPagination;
  const page=role==='Staff'?await load('staff-fixture.jsx',staffFixture):await load('src/pages/doctor/Doctor_Patients.jsx',doctor+'\nexport {PatientListPage};');
  const run=()=>rt.run(()=>role==='Staff'?page.namespace.StaffFixture(props):({table:page.namespace.PatientListPage({...props,setSearchTerm:value=>{props.searchTerm=value;}})}));
  function expand(node){if(Array.isArray(node))return node.map(expand);if(!node||typeof node!=='object')return node;
    if(typeof node.type==='function')return expand(node.type(node.props));return {...node,props:{...node.props,children:expand(node.props?.children)}};}
  const all=(node,predicate)=>Array.isArray(node)?node.flatMap(n=>all(n,predicate)):!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...all(node.props?.children,predicate)];
  return {views,run, update(rows){props.patients=rows;}, tree:()=>expand(run().table), nodes(predicate){return all(this.tree(),predicate);},
    ids(){return this.nodes(n=>n.type==='tr'&&n.key!==null).map(n=>String(n.key));},
    button(label){return this.nodes(n=>n.type==='button'&&n.props['aria-label']===label)[0];},
    click(label){const b=this.button(label);check(!!b,role+': '+label+' exists');if(!b.props.disabled)b.props.onClick();return run();},
    search(value){if(role==='Staff')run().setQuery(value);else props.searchTerm=value;return run();},
    size(value){this.nodes(n=>n.type==='select'&&n.props['aria-label']==='Rows per page')[0].props.onChange({target:{value:String(value)}});return run();},
    html(){return renderToStaticMarkup(run().table);},
  };
}
const patient=(i,name=`Patient ${String(i).padStart(3,'0')}`,s='active')=>({name,id:`PT-${String(i).padStart(3,'0')}`,patientId:`PT-${String(i).padStart(3,'0')}`,recordId:`uuid-${i}`,
 birthdate:'Jan 1, 2000',dateOfBirth:'Jan 1, 2000',sexAge:'Female 26',gender:'Female',age:26,status:s,initials:'PT'});
for(const role of ['Staff','Doctor']) {
 for(const size of [0,1,10,11,15,16,47]) for(const limit of [10,15]) {
  const rows=Array.from({length:size},(_,i)=>patient(i)).reverse();const f=await fixture(role,rows);f.size(limit);
  const pages=Math.max(1,Math.ceil(size/limit)),seen=[];
  check(f.button('Previous patients page').props.disabled,role+': previous disabled initially');
  for(let page=1;page<=pages;page++){
   const ids=f.ids();equal(ids.length,Math.min(limit,Math.max(0,size-(page-1)*limit)),role+': partial page count');seen.push(...ids);
   check(f.html().includes(`Page ${page} of ${pages}`),role+': dynamic page count');
   if(page<pages)f.click('Next patients page');
  }
  equal(new Set(seen).size,size,role+': no duplicate or missing records');
  equal(seen,Array.from({length:size},(_,i)=>role==='Staff'?patient(i).id:patient(i).recordId),role+': globally sorted before slicing');
  check(f.button('Next patients page').props.disabled,role+': next disabled at end');
  if(pages>1){f.click('Previous patients page');check(f.html().includes(`Page ${pages-1} of ${pages}`),role+': Previous works');}
 }
 const f=await fixture(role,Array.from({length:36},(_,i)=>patient(i)));
 f.click('Next patients page');f.click('Next patients page');f.search('Patient 035');equal(f.ids().length,1,role+': search after navigation resets');check(f.html().includes('Page 1 of 1'),role+': search page one');
 f.search('');f.click('Next patients page');f.size(15);check(f.html().includes('Page 1 of 3'),role+': changing rows resets');
 f.click('Next patients page');f.click('Next patients page');f.update([patient(0)]);equal(f.ids().length,1,role+': shrinking data immediately clamps');f.update(Array.from({length:36},(_,i)=>patient(i)));check(f.html().includes('Page 1 of 3'),role+': clamped page retained after growth');
 f.search('no-match');equal(f.ids(),[],role+': empty search');check(f.html().includes('Showing 0-0 of 0'),role+': empty count');
 const names=[patient(4,'zoe'),patient(3,'ALICE'),patient(2,'alice'),patient(1,'Ána'),patient(0,'Ñora')];
 const sorted=await fixture(role,names);equal(sorted.ids(),[2,3,1,0,4].map(i=>role==='Staff'?patient(i).id:patient(i).recordId),role+': locale/case sorting and stable ID tie break');equal(names[0].name,'zoe',role+': does not mutate cached data');
 if(role==='Staff'){
  sorted.run().requestSort('name');equal(sorted.ids()[0],patient(4).id,'Staff: existing descending name control');
  sorted.run().requestSort('id');equal(sorted.ids()[0],patient(0).id,'Staff: existing Patient ID sorting');
  const groups=['active','unlinked','archived','inactive','pending_activation'];const all=await fixture(role,groups.map((s,i)=>patient(i,`Patient ${i}`,s)));
  equal(all.ids().length,5,'All includes inactive and legacy pending records');
  for(const [label,s]of [['Active','active'],['Not Linked','unlinked'],['Archived','archived']]){all.run().setPatientStatusFilter(label);equal(all.ids(),[patient(groups.indexOf(s)).id],'Staff: '+label+' filter');}
  const many=await fixture(role,Array.from({length:25},(_,i)=>patient(i)));many.click('Next patients page');many.run().setPatientStatusFilter('Archived');equal(many.ids(),[],'Staff: filter after paging resets safely');check(many.html().includes('Page 1 of 1'),'Staff: empty filter page');
 }else{
  const view=sorted.nodes(n=>n.type==='button'&&n.props.className==='doctor-patient-view-btn')[0];view.props.onClick();equal(sorted.views,['uuid-2'],'Doctor: View retains internal Patient UUID');
 }
}
const filters=variable('patientStatusFilters');equal(new Function('return '+filters.slice(filters.indexOf('=')+1))(),['All','Active','Not Linked','Archived'],'Only requested filter choices');
const css=postcss.parse(read('src/styles/patient-table-pagination.css'));let mobile=false;css.walkAtRules('media',r=>{if(r.params==='(max-width: 600px)')mobile=true;});check(mobile,'Compact footer wraps on mobile');
for(const role of ['Staff','Doctor']){const f=await fixture(role,[patient(0)]);const html=f.html();check(html.includes('patients-table-pagination'),'Footer renders within table card');check(html.indexOf('patients-table-pagination')>html.indexOf('</table>'),'Footer follows table scroll content');check(!html.includes('appointments page'),'Patient controls have correct accessible names');}
// The previous JSX-only checks missed a desktop fixed-height overflow conflict.
// Verify the actual card/scroller relationship and the narrowly scoped CSS repair.
const doctorCard = '.doctor-dashboard:not(.staff-dashboard-shell) .doctor-patients-page .doctor-patients-table-card';
const doctorScroller = doctorCard + ' > .doctor-patients-table-scroll';
const rules = [];
css.walkRules(rule => rules.push(rule));
const ruleFor = selector => rules.find(rule => rule.selector.replace(/\s+/g, ' ').trim() === selector);
const declaration = (rule, prop) => rule?.nodes.find(node => node.type === 'decl' && node.prop === prop);
const cardRule = ruleFor(doctorCard), scrollerRule = ruleFor(doctorScroller);
check(declaration(cardRule, 'display')?.value === 'flex', 'Doctor fixed-height card reserves a row for the footer');
check(declaration(cardRule, 'flex-direction')?.value === 'column', 'Doctor footer follows vertical table content');
check(declaration(scrollerRule, 'height')?.value === 'auto' && declaration(scrollerRule, 'height')?.important,
  'Doctor scroller overrides the old important 100% height');
check(declaration(scrollerRule, 'flex')?.value === '1 1 auto', 'Only Doctor table body shrinks to make room');
const appliesAtWidth = (rule, width) => {
  for(let parent=rule.parent;parent;parent=parent.parent) {
    if(parent.type!=='atrule'||parent.name!=='media')continue;
    const min=parent.params.match(/min-width:\s*(\d+)px/);
    const max=parent.params.match(/max-width:\s*(\d+)px/);
    if((min&&width<Number(min[1]))||(max&&width>Number(max[1])))return false;
  }
  return true;
};
for (const rule of [cardRule, scrollerRule])equal(rule.parent.params, '(min-width: 981px)', 'Fix uses the existing desktop height breakpoint');
for (const width of [1440, 1024, 768, 375]) {
  const appliedCard=rules.find(rule=>rule.selector.replace(/\s+/g,' ').trim()===doctorCard&&appliesAtWidth(rule,width));
  const appliedScroller=rules.find(rule=>rule.selector.replace(/\s+/g,' ').trim()===doctorScroller&&appliesAtWidth(rule,width));
  if(width>=981) {
    check(declaration(appliedCard,'display')?.value==='flex', width+': desktop card reserves footer space');
    check(declaration(appliedScroller,'height')?.value==='auto', width+': desktop scroller leaves space for footer');
  }else{
    check(!appliedCard&&!appliedScroller, width+': tablet/mobile keep existing automatic table sizing');
  }
}
check(declaration(ruleFor('.appointment-ui-pagination.patients-table-pagination'), 'flex')?.value === '0 0 auto',
  'Footer cannot shrink out of the Doctor card');
const directoryStyles = postcss.parse(read('src/styles/doctor-patients.css'));
let desktopHeightPreserved=false, scrollingPreserved=false;
directoryStyles.walkRules(rule=>{
  if(rule.selector.replace(/\s+/g, ' ').trim()===doctorCard && declaration(rule, 'height')?.value==='clamp(520px, calc(100vh - 300px), 650px)')desktopHeightPreserved=true;
  if(rule.selector.replace(/\s+/g, ' ').trim()===doctorScroller.replace(' .doctor-patients-table-card >', '') && declaration(rule, 'overflow-y')?.value==='auto')scrollingPreserved=true;
});
check(desktopHeightPreserved && scrollingPreserved, 'Existing Doctor card height and body scrolling preserved');
const doctorPages=await fixture('Doctor',Array.from({length:26},(_,i)=>patient(i)));
for(let page=1;page<=3;page++) {
  const cards=doctorPages.nodes(node=>node.props.className==='doctor-patients-table-card');
  equal(cards.length,1,'One Doctor table card');
  const children=cards[0].props.children.filter(Boolean);
  equal(children.map(node=>node.props.className),['doctor-patients-table-scroll','appointment-ui-pagination patients-table-pagination'],
    'Footer is the card sibling of the scroller, never inside it');
  for(const view of doctorPages.nodes(node=>node.type==='button'&&node.props.className==='doctor-patient-view-btn'))view.props.onClick();
  if(page<3)doctorPages.click('Next patients page');
}
equal(doctorPages.views,Array.from({length:26},(_,i)=>patient(i).recordId),'Every View button across pages retains its Patient UUID');
const defaultUi=read('src/components/appointments/AppointmentUi.jsx');check(defaultUi.includes('itemLabel = "appointments"'),'Existing appointment pagination accessible labels preserved');
console.log(`PASS: ${checks} Patient directory pagination/sort/status/interaction assertions. Synthetic records; actual source/hooks/JSX, no live transport or browser layout claim.`);
