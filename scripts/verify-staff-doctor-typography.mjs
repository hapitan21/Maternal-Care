// Offline typography contracts; no browser, authenticated client or live transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { parse } from 'espree';
import { transformWithOxc } from 'vite';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
if(!vm.SourceTextModule){const r=spawnSync(process.execPath,['--experimental-vm-modules',...process.argv.slice(1)],{stdio:'inherit',windowsHide:true});process.exit(r.status??1);}
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const read=file=>fs.readFileSync(file,'utf8');
const sheets=new Map();
const sheet=file=>{if(!sheets.has(file))sheets.set(file,postcss.parse(read('src/styles/'+file)));return sheets.get(file);};
const normalize=selector=>selector.replace(/\s+/g,' ').trim();
const matching=(file,selector)=>{const found=[];sheet(file).walkRules(rule=>{if(rule.selectors.some(s=>normalize(s)===selector))found.push(rule);});return found;};
const weight=(file,selector)=>matching(file,selector).flatMap(r=>r.nodes.filter(n=>n.type==='decl'&&n.prop==='font-weight')).at(-1)?.value;
const nav='.doctor-dashboard .doctor-sidebar .doctor-nav-link > span:first-of-type';
const sections='.doctor-dashboard:not(.staff-dashboard-shell) .clinical-workflow--reminders .doctor-reminder-card__header h2';
const navRules=matching('doctor-dashboard.css',nav), sectionRules=matching('doctor-reminder.css',sections);
equal(navRules.length,1,'One scoped navigation label rule');
equal(weight('doctor-dashboard.css',nav),'700','Both active/inactive sidebar labels are Bold');
equal(weight('doctor-reminder.css',sections),'700','Three Doctor Reminder card headings are Bold');
for(const rule of [...navRules,...sectionRules]) {
 equal(rule.nodes.filter(n=>n.type==='decl').map(n=>n.prop),['font-weight'],'New rules change typography only');
 equal(rule.parent.type,'root','Requested label weights apply at all responsive widths');
 check(!/profile|input|table|patient-pwa|admin/.test(rule.selector),'No unrelated profile/input/table/Patient/Admin selector');
}
check(!navRules[0].nodes.find(n=>n.type==='decl').important,'Sidebar labels require no important override');
const sectionDecl=sectionRules[0].nodes.find(n=>n.type==='decl');check(sectionDecl.important,'Reminder heading overrides existing important shared rule');
let specific=0,existing=0;selectorParser(s=>s.walkClasses(()=>specific++)).processSync(sections);selectorParser(s=>s.walkClasses(()=>existing++)).processSync('.doctor-dashboard .clinical-workflow--reminders .doctor-reminder-card__header h2');
check(specific>existing,'Reminder scope wins existing shared important rule without changing shared CSS');
const preserved=[
 ['doctor-dashboard.css','.doctor-dashboard .doctor-content .doctor-topbar h2','800'],
 ['doctor-dashboard.css','.doctor-dashboard .doctor-content .doctor-patients-header h2','800'],
 ['doctor-dashboard.css','.doctor-dashboard .doctor-content .doctor-appointments-header h1','800'],
 ['doctor-dashboard.css','.doctor-dashboard .doctor-content .doctor-dashboard-header.doctor-reminder-header h1','800'],
 ['patient-record-ui-system.css','.patient-ui-title-block h1','800'],
 ['appointment-ui-system.css','.appointment-ui-title-block > h1','800'],
 ['staff-doctor-parity.css','.staff-dashboard-shell .staff-dashboard-home > .doctor-topbar.staff-section-header > h2','800'],
 ['patient-record-ui-system.css','.doctor-dashboard .medical-record-workspace .mr-page-header h1','800'],
 ['patient-record-ui-system.css','.doctor-dashboard .medical-record-workspace .mr-name-row h2','800'],
 ['doctor-dashboard.css','.doctor-dashboard .doctor-global-profile-slot .doctor-profile-info strong','700'],
 ['staff-dashboard.css','.staff-dashboard-shell .doctor-profile-info strong','500'],
 ['doctor-reminder.css','.doctor-reminder-profile-copy strong','700'],
 ['doctor-reminder.css','.doctor-reminder-profile-copy small','400'],
];
for(const[file,selector,expected]of preserved)equal(weight(file,selector),expected,'Declared weight preserved/correct: '+selector);
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const value of Object.values(node))for(const child of Array.isArray(value)?value:[value]){const found=find(child,predicate);if(found)return found;}return null;}
const parseJs=source=>parse(source,{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true},range:true});
for(const[role,file,expected]of [['Staff','src/pages/staff/StaffDashboard.jsx',['Dashboard','Patients','Appointments']],['Doctor','src/pages/doctor/Doctor_Dashboard.jsx',['Dashboard','Patients','Appointments','Reminders']]]) {
 const source=read(file),ast=parseJs(source);const items=find(ast,n=>n.type==='VariableDeclarator'&&n.id?.name==='navItems');
 const labels=items.init.elements.map(n=>n.properties.find(p=>p.key.name==='label').value.value);
 equal([...labels].sort(),[...expected].sort(),role+' navigation retains original destinations');
 check(source.includes('<span>{item.label}</span>'),role+' dynamic label span remains unchanged');
}
const reminder=read('src/pages/doctor/Doctor_Reminder.jsx');
for(const title of ['Appointment Reminder','Medication Reminder','Health Tips'])check(reminder.includes('<h2>'+title+'</h2>'),'Existing Reminder heading: '+title);
const records=read('src/pages/doctor/Doctor_Medical_Records.jsx'), ast=parseJs(records);
const row=find(ast,n=>n.type==='JSXElement'&&n.openingElement.attributes.some(a=>a.name?.name==='className'&&a.value?.value==='mr-name-row'));
const name=row.children.find(n=>n.type==='JSXElement'&&n.openingElement.name.name==='h2');
const code=(await transformWithOxc('export function Name({patient}){return '+records.slice(...name.range)+';}', 'Name.jsx',{jsx:{runtime:'automatic',development:false}})).code;
const context=vm.createContext({});const module=new vm.SourceTextModule(code,{context});
await module.link(spec=>{equal(spec,'react/jsx-runtime','Dynamic Patient name fragment has no data/transport dependency');return new vm.SyntheticModule(Object.keys(jsx),function(){for(const[k,v]of Object.entries(jsx))this.setExport(k,v);},{context});});await module.evaluate();
for(const full_name of ['Synthetic Patient One','Niña Dela Cruz','Synthetic Long Patient Name '.repeat(5),'']) {
 const html=renderToStaticMarkup(React.createElement(module.namespace.Name,{patient:{full_name}}));
 equal(html,'<h2>'+(full_name||'Patient Record')+'</h2>','Actual dynamic name JSX preserves value/fallback');
}
check(records.includes('<h1>Medical Record</h1>'),'Original Medical Record title retained');
// Optional task-start CSS snapshots establish that sizes, spacing, colors,
// responsive rules and all unrelated declarations are byte-logically unchanged.
const baselineDir=process.argv[2];
if(baselineDir)for(const[file,added]of [['doctor-dashboard.css',nav],['doctor-reminder.css',sections]]){
 const baseline=postcss.parse(fs.readFileSync(path.join(baselineDir,file),'utf8'));const current=sheet(file).clone();
 current.walkRules(rule=>{if(normalize(rule.selector)===added)rule.remove();});
 const declarations=root=>{const result=[];root.walkDecls(d=>{let selector=d.parent.selector||d.parent.params||'';let scope=[];for(let p=d.parent.parent;p;p=p.parent)if(p.type==='atrule')scope.unshift(p.name+' '+p.params);
 let value=d.value;if(file==='doctor-reminder.css'&&selector==='.doctor-reminder-profile-copy strong'&&d.prop==='font-weight')value='500';
 result.push([scope,selector,d.prop,value,!!d.important]);});return result;};
 equal(declarations(current),declarations(baseline),file+': no unrelated declaration/layout/responsive changes');
}
console.log('PASS: '+checks+' typography/source/SSR preservation assertions. CSS declarations only; browser geometry and computed styles not claimed.');
