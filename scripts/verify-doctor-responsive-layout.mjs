// CSS cascade + bounded width model only; no browser rendering or backend access.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const source = async path => (await readFile(new URL('../' + path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const parsed = await Promise.all(['src/styles/doctor-dashboard.css', 'src/styles/doctor-viewprofile.css', 'src/styles/doctor-settings.css'].map(async path => postcss.parse(await source(path))));
function parts(value, delimiter = ' ') {
  const result = []; let depth = 0, token = '';
  for (const char of value.trim()) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (depth === 0 && char === delimiter) { if (token) result.push(token); token = ''; }
    else token += char;
  }
  if (token) result.push(token); return result;
}
function node(tag, className = '', parent = null, attrs = {}) {
  const element = { tag, classes: className.split(' '), attrs, parent, children: [] };
  parent?.children.push(element); return element;
}
function simpleMatch(selector, element) {
  if (!element || /:(?!first-child|last-child|root)|::/.test(selector)) return false;
  if (selector.includes(':root') && element.parent) return false;
  if (selector.includes(':first-child') && element.parent?.children[0] !== element) return false;
  if (selector.includes(':last-child') && element.parent?.children.at(-1) !== element) return false;
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:="([^"\]]+)")?\]/g)];
  if (attributes.some(([, key, value]) => !Object.hasOwn(element.attrs, key) || (value !== undefined && element.attrs[key] !== value))) return false;
  const clean = selector.replace(/\[[^\]]+\]/g, '').replace(/:[\w-]+/g, '');
  const tag = clean.match(/^[\w-]+/)?.[0];
  if (tag && tag !== element.tag) return false;
  const classes = [...clean.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  return classes.every(value => element.classes.includes(value)) && !clean.includes('#');
}
function matches(selector, element) {
  const chain = parts(selector.replace(/\s*>\s*/g, ' > '));
  let index = chain.length - 1, current = element;
  if (!simpleMatch(chain[index--], current)) return false;
  while (index >= 0) {
    if (chain[index] === '>') { index--; current = current.parent; if (!simpleMatch(chain[index--], current)) return false; }
    else { const wanted = chain[index--]; current = current.parent; while (current && !simpleMatch(wanted, current)) current = current.parent; if (!current) return false; }
  }
  return true;
}
function specificity(selector) {
  const attributes = (selector.match(/\[[^\]]+\]/g) || []).length;
  const clean = selector.replace(/\[[^\]]+\]/g, '');
  return attributes * 10 + (clean.match(/\.[\w-]+|:[\w-]+/g) || []).length * 10 + parts(clean).filter(value => /^[a-z]/.test(value)).length;
}
function widthMatch(query, width) {
  return [...query.matchAll(/(min|max)-width:\s*([\d.]+)px/g)].every(([, bound, value]) => bound === 'max' ? width <= Number(value) : width >= Number(value));
}
function allowed(rule, element, viewport, containers, containerSupport) {
  for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    if (/keyframes$/.test(parent.name)) return false;
    if (parent.name === 'media' && (!/width:/.test(parent.params) || !widthMatch(parent.params, viewport))) return false;
    if (parent.name === 'container') {
      if (!containerSupport) return false;
      const name = parent.params.split(' ')[0];
      const container = containers.find(item => item.name === name && ancestors(element).includes(item.element));
      if (!container || !widthMatch(parent.params, container.width)) return false;
    }
  }
  return true;
}
function ancestors(element) { const result = []; for (let parent = element.parent; parent; parent = parent.parent) result.push(parent); return result; }
function expanded(declaration) {
  const result = [[declaration.prop, declaration.value]];
  if (declaration.prop === 'padding') {
    const values = parts(declaration.value);
    const [top, right = top, bottom = top, left = right] = values;
    for (const [side, value] of [['top',top],['right',right],['bottom',bottom],['left',left]]) result.push(['padding-' + side, value]);
  }
  if (declaration.prop === 'overflow') { const [x, y = x] = parts(declaration.value); result.push(['overflow-x', x], ['overflow-y', y]); }
  return result;
}
function resolve(value, variables) {
  for (let count = 0; value?.includes('var('); count++) {
    if (count > 30) throw Error('Unresolved CSS variable ' + value);
    const begin = value.indexOf('var('); let end = begin + 4, depth = 1;
    for (; depth && end < value.length; end++) { if (value[end] === '(') depth++; if (value[end] === ')') depth--; }
    const inner = value.slice(begin + 4, end - 1), comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0,comma)).trim();
    const replacement = variables[name] ?? (comma < 0 ? '' : inner.slice(comma + 1).trim());
    value = value.slice(0,begin) + replacement + value.slice(end);
  }
  return value;
}
function cascade(viewport, containers = [], containerSupport = true, stylesheets = parsed) {
  const cache = new Map();
  return function style(element) {
    if (cache.has(element)) return cache.get(element);
    const inherited = element.parent ? Object.fromEntries(Object.entries(style(element.parent)).filter(([key]) => key.startsWith('--'))) : {};
    const winners = new Map(); let order = 0;
    for (const sheet of stylesheets) sheet.walkRules(rule => {
      order++; if (!allowed(rule, element, viewport, containers, containerSupport)) return;
      const candidates = parts(rule.selector, ',').filter(selector => matches(selector, element));
      if (!candidates.length) return;
      const weight = Math.max(...candidates.map(specificity));
      for (const declaration of rule.nodes.filter(child => child.type === 'decl')) {
        for (const [property, value] of expanded(declaration)) {
          const priority = [Number(Boolean(declaration.important)), weight, order];
          const previous = winners.get(property);
          if (!previous || priority[0] > previous.priority[0] || priority[0] === previous.priority[0] && (priority[1] > previous.priority[1] || priority[1] === previous.priority[1] && priority[2] >= previous.priority[2])) winners.set(property, { value, priority });
        }
      }
    });
    const result = { ...inherited, ...Object.fromEntries([...winners].map(([key, value]) => [key, value.value])) };
    const variables = { ...result };
    for (const [property,value] of Object.entries(result)) if (!property.startsWith('--')) result[property] = resolve(value, variables);
    cache.set(element, result); return result;
  };
}
const px = value => Number.parseFloat(value || '0');
function tracks(value) {
  const repeat = value?.match(/^repeat\((\d+),\s*(.*)\)$/);
  return repeat ? Array(Number(repeat[1])).fill(repeat[2]) : parts(value || '');
}
function minimum(value) { return value.startsWith('minmax(') ? px(value.slice(7).split(',')[0]) : value.endsWith('px') ? px(value) : 0; }
function requiredGrid(style) {
  const columns = tracks(style['grid-template-columns']);
  return columns.reduce((sum, value) => sum + minimum(value), 0) + Math.max(0, columns.length - 1) * px(style.gap) + px(style['padding-left']) + px(style['padding-right']);
}
function fixture() {
  const html = node('html'), root = node('div', 'doctor-dashboard', html), main = node('main', 'doctor-main', root), content = node('div', 'doctor-content', main);
  const profile = node('section', 'doctor-profile-page', content), hero = node('section', 'doctor-profile-hero-card', profile);
  const contact = node('div', 'doctor-profile-contact-item', hero); node('div', 'doctor-profile-contact-icon', contact);
  const contactText = node('div', '', contact), email = node('strong', '', contactText);
  const info = node('div', 'doctor-profile-main-info', hero), license = node('span', '', info);
  const card = node('section', 'doctor-profile-tabs-card', profile), panel = node('div', 'doctor-profile-tab-content', card);
  const personalColumn = node('div', 'doctor-profile-info-column', panel), row = node('div', 'doctor-profile-info-row', personalColumn);
  const icon = node('div', 'doctor-profile-row-icon', row), text = node('div', 'doctor-profile-row-text', row);
  const label = node('span', '', text), value = node('strong', '', text);
  const professionalColumn = node('div', 'doctor-profile-detail-column', panel), detail = node('div', 'doctor-profile-detail-row', professionalColumn);
  const detailLabel = node('span', '', detail), detailValue = node('strong', '', detail);
  const settings = node('section', 'doctor-settings-page', content, { 'data-panel': 'availability' });
  const shell = node('div', 'doctor-settings-shell', settings, { 'data-panel': 'availability' });
  const sidebar = node('aside', 'doctor-settings-sidebar', shell), settingsContent = node('section', 'doctor-settings-content', shell);
  const availability = node('section', 'doctor-settings-availability-panel', settingsContent);
  const header = node('header', 'doctor-settings-section-header doctor-settings-section-header--with-action', availability);
  node('span', '', header); const title = node('div', '', header), edit = node('button', '', header);
  const table = node('div', 'doctor-settings-schedule-table', availability); node('h3', '', table);
  const head = node('div', 'doctor-settings-schedule-head', table); for (let i = 0; i < 3; i++) node('span', '', head);
  const schedule = node('button', '', table), day = node('span', 'doctor-settings-schedule-day', schedule), dot = node('i', '', day);
  const time = node('span', 'doctor-settings-schedule-time', schedule), timeIcon = node('svg', 'doctor-icon', time);
  const mark = node('mark', '', schedule); node('span', '', mark);
  const closed = node('button', 'is-closed', table), closedMark = node('mark', 'is-closed', closed);
  const overlay = node('div', 'doctor-settings-edit-overlay', settings), modal = node('form', 'doctor-settings-edit-modal', overlay);
  const modalClose = node('button', '', modal), modalActions = node('div', '', modal), save = node('button', '', modalActions), cancel = node('button', '', modalActions);
  return { root, main, profile, hero, card, panel, personalColumn, professionalColumn, row, icon, text, label, value, detail, detailLabel, detailValue, contactText, email, license, settings, shell, sidebar, availability, header, title, edit, table, head, schedule, day, dot, time, timeIcon, mark, closedMark, overlay, modal, modalClose, modalActions, save, cancel };
}
// Exercise specificity/importance before applying the model to production CSS.
{
  const root = node('div', 'root'), child = node('div', 'child', root);
  const rules = postcss.parse('.root .child {width: 1px !important} .child {width: 2px !important} @media (max-width:390px) {.root .child {width: 3px !important}}');
  check(cascade(390, [], true, [rules])(child).width === '3px', 'Cascade model applies later equally-specific important media rule');
  check(cascade(768, [], true, [rules])(child).width === '1px', 'Cascade model preserves higher specificity outside media');
}
const report = [];
for (const width of [320,390,768,1024,1241,1440]) {
  const f = fixture(), base = cascade(width);
  const shellTracks = tracks(base(f.root)['grid-template-columns']);
  const dashboardSidebar = base(f.root).display === 'block' ? 0 : px(shellTracks[0]);
  const workspace = width - dashboardSidebar - px(base(f.main)['padding-left']) - px(base(f.main)['padding-right']);
  const settingsTracks = tracks(base(f.shell)['grid-template-columns']);
  const sidebarTrack = settingsTracks.length === 1 ? 0 : settingsTracks[0].startsWith('minmax(') ? px(settingsTracks[0].split(',')[1]) : px(settingsTracks[0]);
  const panelWidth = workspace - sidebarTrack - (settingsTracks.length === 1 ? 0 : px(base(f.shell).gap));
  const style = cascade(width, [{ name: 'doctor-availability', element: f.availability, width: panelWidth }]);
  const profileWidth = Math.min(1120, workspace), panelStyle = style(f.panel), profileColumns = tracks(panelStyle['grid-template-columns']).length;
  const columnWidth = (profileWidth - 2 - px(panelStyle['padding-left']) - px(panelStyle['padding-right']) - (profileColumns - 1) * px(panelStyle.gap)) / profileColumns;
  const personalTextWidth = columnWidth - px(style(f.icon).width) - px(style(f.row).gap);
  check(workspace > 0 && panelWidth > 0 && columnWidth > 0, width + ': model has positive available widths');
  check(requiredGrid(style(f.text)) <= personalTextWidth, width + ': Personal field track minimum fits its column');
  check(requiredGrid(style(f.detail)) <= columnWidth, width + ': Professional field track minimum fits its column');
  check(tracks(style(f.text)['grid-template-columns']).length === (width <= 760 ? 1 : 2), width + ': Personal label/value stacking follows breakpoint');
  check(tracks(style(f.detail)['grid-template-columns']).length === (width <= 760 ? 1 : 2), width + ': Professional label/value stacking follows breakpoint');
  for (const element of [f.email,f.license,f.label,f.value,f.detailLabel,f.detailValue]) {
    const value = style(element);
    check(value['overflow-wrap'] === 'anywhere' && value['min-width'] === '0', width + ': long email/license/address/label can shrink and wrap');
    check(value.display !== 'none' && value.visibility !== 'hidden' && value['white-space'] !== 'nowrap', width + ': field remains exposed rather than truncated');
  }
  for (const element of [f.contactText,f.personalColumn,f.professionalColumn]) check(style(element)['min-width'] === '0', width + ': flex/grid wrapper can shrink');
  check(style(f.availability)['container-type'] === 'inline-size' && style(f.availability)['container-name'] === 'doctor-availability', width + ': query uses actual availability panel');
  for (const element of [f.head,f.schedule]) {
    const rowStyle = style(element);
    check(rowStyle['min-width'] === '0', width + ': legacy 620px row minimum removed');
    check(tracks(rowStyle['grid-template-columns']).length === (panelWidth <= 700 ? 1 : 3), width + ': table responds to container width');
    check(requiredGrid(rowStyle) <= panelWidth - 10, width + ': schedule tracks/padding fit including borders and scrollbar allowance');
    if (element === f.head) check(rowStyle.display === (panelWidth <= 700 ? 'none' : 'grid'), width + ': redundant column header disappears only with stacked rows');
    else check(rowStyle.display !== 'none' && rowStyle['overflow-wrap'] === 'anywhere', width + ': complete interactive row remains exposed');
  }
  check(style(f.table)['overflow-x'] === 'auto' && style(f.table)['overflow-y'] === 'auto', width + ': availability has safe horizontal/vertical recovery');
  check(style(f.dot)['flex-shrink'] === '0' && style(f.timeIcon)['flex-shrink'] === '0', width + ': day/time icons remain legible');
  for (const element of [f.mark,f.closedMark]) check(style(element).display === 'inline-flex' && px(style(element)['min-width']) <= panelWidth - 58, width + ': Available and Closed badges fit');
  check(style(f.edit).display !== 'none' && px(style(f.edit)['min-width']) <= panelWidth, width + ': Edit/Configure control remains available');
  if (panelWidth <= 700) check(tracks(style(f.header)['grid-template-columns']).length === 2 && style(f.edit)['grid-column'] === '1 / -1', width + ': title and action button have separate rows');
  else check(tracks(style(f.header)['grid-template-columns']).length === 3, width + ': desktop header layout preserved');
  const modalStyle = style(f.modal), modalWidth = width <= 520 ? width - 28 : Math.min(440,width-36);
  check(style(f.overlay).position === 'fixed' && style(f.overlay)['z-index'] === '60000', width + ': guarded modal remains above profile controls');
  check(modalWidth < width && style(f.modal)['overflow-y'] === 'auto' && px(style(f.modalClose).width) > 0, width + ': modal has viewport clearance and scrollable controls');
  check(px(style(f.save)['min-width']) + px(style(f.cancel)['min-width']) + px(style(f.modalActions).gap) <= modalWidth - px(modalStyle['padding-left']) - px(modalStyle['padding-right']), width + ': Save/Cancel minimum widths fit modal');
  // No container-query support: the table must scroll instead of clipping.
  const fallback = cascade(width, [], false);
  check(fallback(f.table)['overflow-x'] === 'auto' && fallback(f.schedule)['min-width'] === '0', width + ': older-browser fallback exposes overflow');
  check(fallback(f.head).display === (width <= 900 ? 'none' : 'grid'), width + ': fallback header matches viewport-based stacking');
  report.push({ viewport: width, workspace, availabilityPanel: panelWidth, profileFieldColumns: width <= 760 ? 1 : 2, availabilityColumns: panelWidth <= 700 ? 1 : 3, columnHeader: style(f.head).display });
}
// Container threshold cases independent of viewport; protects against narrower
// sidebars/embedding without imposing a desktop viewport breakpoint.
for (const size of [480,700,701,900]) {
  const f = fixture(), style = cascade(1440,[{ name:'doctor-availability',element:f.availability,width:size }]);
  check(tracks(style(f.schedule)['grid-template-columns']).length === (size <= 700 ? 1 : 3), 'Container threshold: ' + size);
  check(style(f.head).display === (size <= 700 ? 'none' : 'grid'), 'Header matches narrow container threshold: ' + size);
}
const profilePage = await source('src/pages/doctor/Doctor_ViewProfile.jsx'), settingsPage = await source('src/pages/doctor/Doctor_Settings.jsx');
check(profilePage.includes('className="doctor-profile-row-text"') && profilePage.includes('className="doctor-profile-detail-row"'), 'Fixtures match actual Profile row classes');
check(settingsPage.includes('className="doctor-settings-schedule-day"') && settingsPage.includes('className="doctor-settings-schedule-time"') && settingsPage.includes('{item.status.toUpperCase()}'), 'Fixtures match complete saved availability row structure');
check(settingsPage.includes('onClick={event => { rememberDoctorSettingsDialogTrigger(scheduleDialogTriggerRef, event); openScheduleEditor(item); }}'), 'Availability rows retain guarded edit interaction');
// Evaluate the actual row-label expression for saved Available and Closed rows.
// The header is a div, so explicit button names preserve associations at every size.
const rowStart = settingsPage.indexOf('availability.map((item) => (');
const rowEnd = settingsPage.indexOf('\n                ) : (', rowStart);
const rowSource = settingsPage.slice(rowStart, rowEnd);
const labelExpression = rowSource.match(/aria-label=\{(`[^`]+`)\}/)?.[1];
check(Boolean(labelExpression), 'Interactive schedule row has an explicit accessible name');
const accessibleName = new Function('item', 'return ' + labelExpression);
for (const [item, expected] of [
  [{day:'Monday',time:'8:00 AM - 12:00 PM',status:'Available'}, 'Edit schedule. Day: Monday. Time: 8:00 AM - 12:00 PM. Status: Available.'],
  [{day:'Tuesday',time:'',status:'Closed'}, 'Edit schedule. Day: Tuesday. Time: No appointments scheduled. Status: Closed.'],
]) check(accessibleName(item) === expected, 'Action/day/time/status accessible association: ' + item.status);
check(rowSource.includes('{item.status === "Closed" ? "No appointments scheduled" : item.time}'), 'Visible closed-day wording and time values unchanged');
check(rowSource.includes('{item.status.toUpperCase()}'), 'Visible status badge wording preserved');
check(settingsPage.includes('<span>Day</span>\n                  <span>Time</span>\n                  <span>Status</span>'), 'Desktop column header labels retained in DOM');
console.table(report);
console.log('Doctor responsive CSS/layout verification passed: ' + checks + ' assertions.');
console.log('Source-level cascade checks and an explicit width model; not browser-rendered layout, font measurement, scrolling or touch verification.');
