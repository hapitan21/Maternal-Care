// Actual shell declarations/JSX with synthetic profile/navigation; no Auth/network imports.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import React from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlarmClock, Bell } from 'lucide-react';
import { parse } from 'espree';
import { transformWithOxc } from 'vite';
import postcss from 'postcss';

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const file = 'src/pages/patient/Patient_PWA.jsx';
const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
const options = { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true };
const tree = parse(source, options);
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    const result = find(child, predicate); if (result) return result;
  }
  return null;
}
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++; };
const declaration = (ast, text, name) => text.slice(...find(ast, node => ['FunctionDeclaration', 'VariableDeclarator'].includes(node.type) && node.id?.name === name).range);
const element = name => find(tree, node => node.type === 'JSXElement' && node.openingElement.attributes.some(item => item.name?.name === 'className' && item.value?.value === name));
const navigations = []; let bellNavigate;
const context = vm.createContext({ ...React, React, AlarmClock,
  Icon: ({ icon, ...props }) => React.createElement('svg', { ...props, 'data-icon': icon }),
  MaternalCareLogo: () => React.createElement('span', null, 'Maternal Care'),
  PatientNotificationBell: ({ onNavigate }) => {
    bellNavigate = onNavigate;
    return React.createElement('button', { 'aria-label': 'Notifications', className: 'fixture-notification' }, React.createElement(Bell), React.createElement('span', null, '3'));
  },
  navigate: path => navigations.push(path), handleNavigate: page => navigations.push(page), handleLogout() {},
  profile: { displayName: 'Synthetic Patient', avatar: '' }, setProfileMenuOpen() {}, setTopbarSecondaryTarget() {}, setTopbarHeadingTarget() {},
});
const routeSource = source.slice(source.indexOf('const navItems ='), source.indexOf('function isMissingPatientLinkingRpc'));
const header = element('pwa-topbar'), nav = element('pwa-nav');
const compiled = (await transformWithOxc(routeSource + '\n' + ['TopProfile', 'Avatar'].map(name => declaration(tree, source, name)).join('\n') +
  '\nexport function renderHeader(){return (' + source.slice(...header.range) + ');}' +
  '\nexport function renderNav(){return (' + source.slice(...nav.range) + ');}' +
  '\nexport {navItems,pageRoutes,getPageFromPath,getActiveNavFromPath,PatientNavigationIcon};', file,
{ jsx: { runtime: 'automatic', development: false } })).code;
const module = new vm.SourceTextModule(compiled, { context });
await module.link(spec => {
  assert.equal(spec, 'react/jsx-runtime');
  return new vm.SyntheticModule(Object.keys(runtime), function () {
    for (const [key, value] of Object.entries(runtime)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
const actual = module.namespace;
context.navItems = actual.navItems;
function open(path) {
  context.activePage = actual.getPageFromPath(path); context.activeNav = actual.getActiveNavFromPath(path);
  return renderToStaticMarkup(actual.renderHeader());
}
for (const path of ['/patient/dashboard', '/patient/medical-record', '/patient/appointments', '/patient/reminders', '/patient/profile', '/patient/settings']) {
  const html = open(path);
  check(!html.includes('pwa-page-label'), 'Standalone label removed');
  check(html.includes('pwa-topbar-heading'), 'Shared heading destination present');
  check(html.includes('Synthetic Patient') && html.includes('<small>Patient</small>'), 'Name and role retained');
  check(html.includes('Open patient profile menu') && html.includes('aria-haspopup="menu"'), 'Existing profile trigger retained');
  check(html.includes('class="fixture-notification"') && html.includes('>3</span>'), 'Notification component slot/badge retained');
}
bellNavigate('/patient/appointments'); equal(navigations.at(-1), '/patient/appointments', 'Existing bell navigation callback forwarded');
const reminders = actual.navItems.find(item => item.key === 'reminders');
equal(reminders.icon, AlarmClock, 'Reminder icon is the installed local outlined AlarmClock');
context.activeNav = 'reminders';
const navHtml = renderToStaticMarkup(actual.renderNav());
equal((navHtml.match(/lucide-alarm-clock/g) || []).length, 1, 'Actual local alarm SVG renders once in sidebar/navigation');
check(navHtml.includes('stroke-width="1.5"') && !navHtml.includes('lucide-bell'), 'Outlined stroke and no reminder bell');
check(navHtml.includes('aria-current="page"') && navHtml.includes('aria-label="Reminders"'), 'Selected state and accessible label retained');

const baseline = execFileSync('git', ['show', 'HEAD:' + file], { encoding: 'utf8' });
const before = parse(baseline, options);
const oldNavDeclaration = declaration(before, baseline, 'navItems');
const oldNav = vm.runInContext('(' + oldNavDeclaration.slice(oldNavDeclaration.indexOf('=') + 1) + ')', context);
for (const item of actual.navItems) {
  const old = oldNav.find(candidate => candidate.key === item.key);
  equal([item.key, item.label, item.mobileLabel], [old.key, old.label, old.mobileLabel], 'Navigation identity and labels unchanged');
  if (item.key !== 'reminders') equal(item.icon, old.icon, 'Other sidebar icons unchanged');
}
for (const name of ['TopProfile', 'Avatar', 'handleLogout', 'handleNavigate', 'getPageFromPath', 'getActiveNavFromPath', 'renderContent', 'pageRoutes']) {
  equal(declaration(tree, source, name).replaceAll('\r\n', '\n'), declaration(before, baseline, name).replaceAll('\r\n', '\n'), name + ' unchanged');
}
const notificationCall = (ast, text) => {
  const node = find(ast, n => n.type === 'JSXElement' && n.openingElement.name.name === 'PatientNotificationBell');
  return text.slice(...node.range).replaceAll('\r\n', '\n');
};
equal(notificationCall(tree, source), notificationCall(before, baseline), 'Actual notification props/callback unchanged');
const bellSource = await readFile(new URL('../src/components/patient/PatientNotificationBell.jsx', import.meta.url), 'utf8');
check(bellSource.includes('import { Bell, BellRing } from "lucide-react"'), 'Actual notification component still uses bells');

// Source-only responsive checks, not browser box/overflow measurements.
const css = postcss.parse(await readFile(new URL('../src/styles/patient-pwa-ui-system.css', import.meta.url), 'utf8'));
function property(selector, prop, width, touch = false) {
  let value;
  css.walkRules(rule => {
    if (rule.selector !== selector) return;
    if (rule.parent.type === 'atrule') {
      const query = rule.parent.params;
      if (!query.split(',').some(part => {
        const max = part.match(/max-width:\s*(\d+)px/);
        if (max) return width <= Number(max[1]);
        return touch && part.includes('hover: none') && part.includes('pointer: coarse');
      })) return;
    }
    rule.walkDecls(prop, item => { value = item.value; });
  });
  return value;
}
for (const width of [320, 375, 768, 1024, 1440]) {
  equal(property('.pwa-topbar:has(.pwa-topbar-heading:not(:empty))', 'grid-template-columns', width), width <= 780 ? 'minmax(0, 1fr) auto auto' : 'minmax(0, 1fr) auto', width + 'px responsive header columns');
  equal(property('.pwa-topbar-heading > .pwa-ui-page-header', 'margin', width), '0', 'No duplicate heading gap');
}
check(!css.toString().includes('.pwa-page-label'), 'Standalone pill CSS removed');
equal(property('.pwa-topbar-heading', 'grid-column', 375), '1 / -1', 'Mobile heading has full row');
equal(property('.pwa-topbar-heading:empty', 'display', 1440), 'none', 'Other pages retain original header flow');

// Execute the shared heading component with a synthetic portal destination, no DOM/network.
const uiSource = await readFile(new URL('../src/components/patient/PatientPwaUi.jsx', import.meta.url), 'utf8');
const uiCompiled = (await transformWithOxc(uiSource, 'PatientPwaUi.jsx', {jsx:{runtime:'automatic',development:false}})).code;
const ui = new vm.SourceTextModule(uiCompiled, {context});
await ui.link(spec => {
  const exports = spec === 'react' ? React : spec === 'react/jsx-runtime' ? runtime : spec === 'react-dom' ? {
    createPortal: (children, target) => React.createElement('div', {'data-portal':target.kind}, children),
  } : {Icon:context.Icon};
  return new vm.SyntheticModule(Object.keys(exports), function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
});
await ui.evaluate();
for (const [page,title] of [['Dashboard','Dashboard'],['MedicalRecords','My Medical Record'],['Appointments','My Appointments'],['Reminder','My Reminders']]) {
  const text = await readFile(new URL('../src/pages/patient/Patient_PWA_' + page + '.jsx', import.meta.url),'utf8');
  const ast = parse(text,options);
  const header = find(ast,n=>n.type==='JSXElement'&&n.openingElement.name.name==='PatientPageHeader');
  const attrs = header.openingElement.attributes;
  const prop = name=>attrs.find(a=>a.name?.name===name);
  check(Boolean(prop('sharedHeader')), page + ' opts into shared header');
  equal(prop('title').value.value,title,'Original heading retained');
  const props = {title,subtitle:prop('subtitle').value.value,sharedHeader:true,action:React.createElement('button',null,'Page action')};
  const render = target=>renderToStaticMarkup(React.createElement(ui.namespace.PatientTopbarSecondaryProvider,{headingTarget:target},React.createElement(ui.namespace.PatientPageHeader,props)));
  const html=render({kind:'heading'});
  equal((html.match(/<h1>/g)||[]).length,1,'One heading only');
  check(html.includes('data-portal="heading"') && html.includes(title) && html.includes(props.subtitle),'Existing title/subtitle moved into heading slot');
  check(html.includes('Page action'),'Existing page action retained');
  check(!html.includes('<header'),'No nested header landmark');
  check(render(null).includes('<header'),'Standalone/fallback heading remains available');
  props.sharedHeader=false;
  check(!render({kind:'heading'}).includes('data-portal'),'Unrelated headers do not move');
}
console.log(`PASS: ${checks} Patient header/icon checks. Actual route/JSX/profile rendering and local SVG, synthetic notification/navigation, CSS-source responsive checks. No real browser/device verification claimed.`);
