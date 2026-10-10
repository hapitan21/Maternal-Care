/* global process */
// Actual request-details JSX, notification dialog and CSS in offline Chrome.
// Appointment review handlers run separately against synthetic RPC spies only.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse } from 'espree';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import postcss from 'postcss';

const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/');
const componentPath = 'src/pages/staff/Staff_Appointments.jsx';
const source = await readFile(join(root, componentPath), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
const functions = ['StaffAppointmentRequestDetails', 'StaffAppointmentRequests', 'formatMonthTitle', 'formatRequestDate', 'getRequestId', 'getRequestCategory', 'getRequestCategoryIcon', 'getCategoryFromAppointmentType'];
const declarations = ast.body.filter(node => node.type === 'FunctionDeclaration' && functions.includes(node.id.name));
assert.equal(declarations.length, functions.length, 'Extract actual component and formatting helpers');
let assertions = 0;
const check = (ok, message) => { assert.ok(ok, message); assertions++; };
const headSource = execFileSync('git', ['show', 'HEAD:' + componentPath], { cwd: root, encoding: 'utf8', windowsHide: true });
const headAst = parse(headSource, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
function find(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'VariableDeclarator' && (node.id.name === name || (node.id.type === 'ArrayPattern' && node.id.elements.some(element => element?.name === name)))) return node;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    const result = find(child, name); if (result) return result;
  }
  return null;
}
const sortCallback = find(ast, 'requestSchedules').init.arguments[0];
const baselineSort = find(headAst, 'requestSchedules').init.arguments[0];
check(sortCallback.body.body.slice(0,2).map(node=>source.slice(...node.range)).join('').replaceAll('\r\n','\n') === baselineSort.body.body.slice(0,2).map(node=>headSource.slice(...node.range)).join('').replaceAll('\r\n','\n'), 'Request search and pending-status filtering unchanged');
check(find(ast, 'requestSort').init.arguments[0].value === 'newest', 'Production default is Newest First');
const pagination = find(ast, 'paginatedRequests').init.arguments[0];
const baselinePagination = find(headAst, 'paginatedRequests').init.arguments[0];
const requestIdHelper = vm.runInNewContext('(' + source.slice(...declarations.find(node => node.id.name === 'getRequestId').range) + ')', {Date});
check(source.slice(...pagination.range).replaceAll('\r\n','\n') === headSource.slice(...baselinePagination.range).replaceAll('\r\n','\n'), 'Request pagination unchanged');
for (const [requestSort, expected] of [['newest','b,a,c'],['oldest','c,a,b']]) {
  const bookingRequests = [
    {id:'a',created_at:'2026-10-02',start_time:'2026-10-03',status:'pending'},
    {id:'b',created_at:'2026-10-03',start_time:'2026-10-01',status:'pending'},
    {id:'c',created_at:'2026-10-01',start_time:'2026-10-02',status:'pending'},
  ];
  const result = vm.runInNewContext('(' + source.slice(...sortCallback.range) + ')', {bookingRequests,requestSort,searchQuery:'',Date})();
  check(result.map(item=>item.id).join(',') === expected, requestSort + ': creation timestamps determine order, not appointment dates');
  const missingDates = [...bookingRequests, {id:'missing',start_time:'2099-01-01',status:'pending'}, {id:'invalid',created_at:'invalid',start_time:'2099-01-02',status:'pending'}];
  const missingResult = vm.runInNewContext('(' + source.slice(...sortCallback.range) + ')', {bookingRequests:missingDates,requestSort,searchQuery:'',Date})();
  check(missingResult.map(item=>item.id).join(',') === (requestSort === 'newest' ? 'b,a,c,missing,invalid' : 'missing,invalid,c,a,b'), requestSort + ': missing/invalid creation dates never use preferred dates');
  const filtered = vm.runInNewContext('(' + source.slice(...sortCallback.range) + ')', {bookingRequests:[...bookingRequests.map(item=>({...item,patient_name:item.id==='a'?'Other':'Matching'})),{id:'closed',patient_name:'Matching',status:'approved',created_at:'2099-01-01'}],requestSort,searchQuery:'matching',Date,getRequestId:requestIdHelper})();
  check(filtered.map(item=>item.id).join(',') === (requestSort === 'newest' ? 'b,c' : 'c,b'), requestSort + ': search and pending filtering preserved');
  const page = vm.runInNewContext('(' + source.slice(...pagination.range) + ')', {requestDisplayedPage:2,requestSchedules:[...result,...result,...result]})();
  check(page.map(item=>item.id).join(',') === [...result,...result,...result].slice(5,10).map(item=>item.id).join(','), requestSort + ': five-row pagination preserved');
}
for (const operation of ['acceptPatientRequest', 'declinePatientRequest']) {
  const callback = find(ast, operation).init.arguments[0];
  const baselineCallback = find(headAst, operation).init.arguments[0];
  const workflow = source.slice(...callback.range).replace(', refreshRequestNotifications()', '').replace('await Promise.all([loadBookingRequests()]);', 'await loadBookingRequests();');
  check(workflow.replaceAll('\r\n', '\n') === headSource.slice(...baselineCallback.range).replaceAll('\r\n', '\n'), operation + ': production workflow unchanged except authoritative notification refresh');
  for (const mode of ['success', 'error', 'busy', 'missing-id', ...(operation === 'acceptPatientRequest' ? ['missing-doctor'] : [])]) {
    const events = [], request = { id: 'offline-request' };
    const context = {
      console: { error() {}, warn() {} }, isReviewingRequest: mode === 'busy', requestDoctorId: mode === 'missing-doctor' ? '' : 'offline-doctor',
      supabase: { rpc: async (name, payload) => { events.push(['rpc', name, payload]); return mode === 'error' ? { error: { message: 'Synthetic refusal' } } : { data: { schedule_id: 'offline-schedule' }, error: null }; } },
      setIsReviewingRequest: value => events.push(['busy', value]), setRequestActionError: value => events.push(['error', value]),
      requestAppointmentSms: async payload => events.push(['sms', payload]), appointmentSmsEvents: { confirmed: 'confirmed' },
      setBookingRequests: updater => events.push(['remaining', updater([request, { id: 'other-request' }])]),
      setSelectedRequest: value => events.push(['selected', value]), setRequestDoctorId: value => events.push(['doctor', value]),
      showSuccessMessage: value => events.push(['success', value]), loadAppointments: async () => events.push(['appointments']), loadBookingRequests: async () => events.push(['requests']),
      refreshRequestNotifications: async () => events.push(['request-count']),
    };
    await vm.runInNewContext('(' + source.slice(...callback.range) + ')', context)(mode === 'missing-id' ? {} : request);
    check(events.some(event=>event[0]==='request-count') === (mode === 'success'), operation + ': request count refresh only follows authoritative RPC success');
    const writes = events.filter(event => event[0] === 'rpc');
    if (['busy', 'missing-id', 'missing-doctor'].includes(mode)) {
      check(writes.length === 0 && !events.some(event => event[0] === 'success'), operation + ': guarded ' + mode);
    } else {
      check(writes.length === 1 && writes[0][1] === (operation === 'acceptPatientRequest' ? 'accept_patient_appointment_request' : 'decline_patient_appointment_request'), operation + ': original RPC');
      check(writes[0][2].p_request_id === request.id, operation + ': exact request target');
      if (operation === 'acceptPatientRequest') check(writes[0][2].p_doctor_id === 'offline-doctor', 'Approval keeps selected Doctor');
      check(events.at(-1)[0] === 'busy' && events.at(-1)[1] === false, operation + ': busy released');
      check(events.some(event => event[0] === 'success') === (mode === 'success'), operation + ': truthful result');
      if (mode === 'success') check(events.some(event => event[0] === 'remaining' && event[1].length === 1 && event[1][0].id === 'other-request'), operation + ': original pending request removal');
      else check(events.some(event => event[0] === 'error' && event[1].includes('Synthetic refusal')), operation + ': original error feedback');
    }
  }
}
{
  const callback = find(ast, 'loadBookingRequests').init.arguments[0], events=[];
  let release;
  const deferred=new Promise(resolve=>release=resolve);
  const context={requestSessionIdentity:'staff-a:session-a',bookingRequestsRequestRef:{current:null},bookingRequestsEpochRef:{current:1},bookingRequestsAbortRef:{current:null},AbortController,
    appointmentRequestTableName:'create_patient_appointment_request',appointmentRequestColumns:'existing-columns',console:{error(){}},
    setStatusMessage:value=>events.push(['error',value]),setIsLoadingRequests:value=>events.push(['loading',value]),setBookingRequests:value=>events.push(['rows',value]),setSelectedRequest:()=>{},
    supabase:{from(){const query={select(){return query},eq(){return query},order(){return query},abortSignal(){return query},then(resolve,reject){return deferred.then(resolve,reject)}};return query}}};
  const load=vm.runInNewContext('('+source.slice(...callback.range)+')',context),first=load();
  check(load()===first,'Request list overlapping fetches coalesce');
  context.bookingRequestsEpochRef.current++;context.bookingRequestsAbortRef.current.abort();
  release({data:[{id:'old-session'}],error:null});await first;
  check(!events.some(event=>event[0]==='rows'),'Old-session/unmounted request-list response cannot publish');
  context.bookingRequestsRequestRef.current=null;
  context.supabase.from=()=>{throw new Error('Synthetic rejected request')};await load();
  check(events.some(event=>event[0]==='loading'&&event[1]===false)&&events.some(event=>event[0]==='error'),'Rejected request list releases loading with retryable feedback');
}
const component = `import {useEffect,useRef,useState} from 'react';import {Icon} from '@iconify/react';
import {useMemo} from 'react';import ProfileAvatarContent from '${root}/src/components/common/ProfileAvatarContent.jsx';
import SendPatientNotificationAction from '${root}/src/components/notifications/SendPatientNotificationAction.jsx';
import {formatAppointmentDate,formatAppointmentTime} from '${root}/src/lib/appointmentDate.js';
import {APPOINTMENT_CATEGORIES,getAppointmentTypeCategory} from '${root}/src/lib/appointmentTypes.js';
const categoryList=APPOINTMENT_CATEGORIES;
${declarations.map(node => source.slice(...node.range)).join('\n')}
export {StaffAppointmentRequests};export default StaffAppointmentRequestDetails;`;
const fixture = `import React,{useState,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';import {addIcon,_api} from '@iconify/react';
import {MemoryRouter,Routes,Route,useNavigate,useLocation} from 'react-router-dom';
import Details,{StaffAppointmentRequests as Requests} from 'request-details-component';
import {useStaffRequestPatientAvatars} from '${root}/src/hooks/useStaffRequestPatientAvatars.js';import {state} from 'request-details-backend';
import '${root}/src/index.css';import '${root}/src/styles/doctor-dashboard.css';import '${root}/src/styles/staff-dashboard.css';
import '${root}/src/styles/doctor-appointments.css';import '${root}/src/styles/appointment-ui-system.css';import '${root}/src/styles/staff-appointments.css';
const iconNames=${JSON.stringify([...new Set([...source.matchAll(/icon="([^"]+)"/g)].map(match => match[1]))])};
for(const name of [...iconNames,'solar:medical-kit-linear','solar:test-tube-linear','solar:monitor-camera-linear','solar:heart-pulse-linear'])addIcon(name,{width:24,height:24,body:'<path fill="currentColor" d="M4 4h16v16H4z"/>'});_api.setFetch(async()=>({status:404}));
const harness={events:[],errors:[],backendCalls:0,state};window.requestDetailsTest=harness;
const createBlob=URL.createObjectURL.bind(URL),revokeBlob=URL.revokeObjectURL.bind(URL);harness.createdUrls=[];harness.revokedUrls=[];
URL.createObjectURL=blob=>{const url=createBlob(blob);harness.createdUrls.push(url);return url};URL.revokeObjectURL=url=>{harness.revokedUrls.push(url);revokeBlob(url)};
const observer=new MutationObserver(()=>{if(!harness.monitorPhotos)return;const avatar=document.querySelector('.doctor-request-patient > span,.doctor-request-detail-avatar');if(avatar&&!avatar.querySelector('img'))harness.flashes=(harness.flashes||0)+1});observer.observe(document.getElementById('root'),{subtree:true,childList:true,attributes:true});
window.addEventListener('error',e=>harness.errors.push(e.message));window.addEventListener('unhandledrejection',e=>harness.errors.push(String(e.reason)));
const patientId='11111111-1111-4111-8111-111111111111';
function Fixture(){const [long,setLong]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[doctor,setDoctor]=useState(''),[screen,setScreen]=useState(harness.nextScreen||'details'),[patient,setPatient]=useState(patientId),[staff,setStaff]=useState(harness.nextStaff||'staff-a'),[sort,setSort]=useState('newest');
useLayoutEffect(()=>{harness.mounts=(harness.mounts||0)+1;return()=>{harness.unmounts=(harness.unmounts||0)+1}},[]);
useLayoutEffect(()=>{if(harness.monitorPhotos){const avatar=document.querySelector('.doctor-request-patient > span,.doctor-request-detail-avatar');if(avatar&&!avatar.querySelector('img'))harness.commitFlashes=(harness.commitFlashes||0)+1}});
Object.assign(harness,{setLong,setBusy,setError,setDoctor,setScreen,setPatient,setStaff,setSort});
const {photos,loadingIds}=useStaffRequestPatientAvatars(staff,screen==='list'?[patientId,'22222222-2222-4222-8222-222222222222']:[patient],screen!=='all');
const patientData={patient_id:long?'PAT-ID'.repeat(18):'PAT-001',age:28,contact_number:long?'0917'.repeat(20):'09171234567',email:long?'longemail'.repeat(20)+'@example.test':'patient@example.test',address:long?'LongStreetAddress'.repeat(22):'Clinic Street, Manila'};
const request={id:'offline-request',patient_id:patient,patient_name:long?'LongPatientName'.repeat(14):'Synthetic Patient',title:long?'PrenatalConsultation'.repeat(12):'Prenatal Checkup',category:'prenatal',status:'pending',created_at:'2026-10-10T01:00:00Z',start_time:'2026-10-12T02:00:00Z'};
return <div className='doctor-dashboard staff-dashboard-shell'><aside className='doctor-sidebar' aria-hidden='true'/><main className='doctor-main'><div className='doctor-content'><section className='staff-appointments-page doctor-request-details-shell appointment-workspace appointment-workspace--staff'>
{screen==='all'?<div>All appointments fixture</div>:screen==='details'?<Details request={request} patient={patientData} patientPhoto={photos.get(patient)||''} patientPhotoLoading={loadingIds.has(patient)} doctors={[{id:'doctor-a',name:'Dr. Synthetic One'},{id:'doctor-b',name:long?'Dr. LongDoctorName'.repeat(16):'Dr. Synthetic Two'}]} selectedDoctorId={doctor} onDoctorChange={value=>{harness.events.push(['doctor',value]);setDoctor(value)}} isUpdating={busy} actionError={error} onBack={()=>{harness.events.push(['back']);if(harness.navigateBack)setScreen('list')}} onApprove={value=>harness.events.push(['approve',value.id])} onDecline={value=>harness.events.push(['decline',value.id])}/>:
<Requests requests={[{...request,patient_id:patientId},{...request,id:'request-b',patient_id:'22222222-2222-4222-8222-222222222222'}]} patientPhotos={photos} loadingPatientPhotos={loadingIds} isLoading={false} totalRequests={2} currentPage={1} totalPages={1} searchTerm='' sortOrder={sort} patients={[]} miniMonthDate={new Date('2026-10-10T00:00:00Z')} miniMonthDays={[]} todayAppointments={[]} onSearchChange={()=>{}} onSortChange={value=>{harness.events.push(['sort',value]);setSort(value)}} onPageChange={()=>{}} onMonthChange={()=>{}} onSelectDate={()=>{}} onViewRequest={r=>{setPatient(r.patient_id);setScreen('details')}} onViewAppointment={()=>{}}/>}
</section></div></main></div>};
function RoutedFixture(){const navigate=useNavigate(),location=useLocation();useLayoutEffect(()=>{harness.navigate=navigate;harness.path=location.pathname},[navigate,location.pathname]);return <Routes><Route path='/staff/appointments' element={<Fixture/>}/><Route path='/staff/dashboard' element={<div data-route='dashboard'>Dashboard route fixture</div>}/><Route path='/staff/patients' element={<div data-route='patients'>Patients route fixture</div>}/></Routes>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/staff/appointments']}><RoutedFixture/></MemoryRouter>);`;
const bundle = await build({ root, configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
  name: 'offline-staff-request-details', enforce: 'pre',
  resolveId(id) {
    if (id.endsWith('request-details-test.jsx')) return '\0request-details-test.jsx';
    if (id === 'request-details-component') return '\0request-details-component.jsx';
    if (id === 'request-details-backend') return '\0request-details-backend.js';
    if (/\/supabaseClient(?:\.js)?$/.test(id)) return '\0request-details-backend.js';
  },
  load(id) {
    if (id === '\0request-details-test.jsx') return fixture;
    if (id === '\0request-details-component.jsx') return component;
    if (id === '\0request-details-backend.js') return `
const listeners=new Set();const patient='11111111-1111-4111-8111-111111111111';
export const state={user:'staff-a',session:'session-a',paths:{[patient]:'linked-patient-user/avatar'},rpcCalls:[],downloads:[],mode:'success',holdFirst:true};
const session=()=>state.user?{user:{id:state.user},access_token:'x.'+btoa(JSON.stringify({session_id:state.session}))+'.x'}:null;
state.auth=(user,logicalSession)=>{state.user=user;state.session=logicalSession;for(const f of listeners)f(user?'SIGNED_IN':'SIGNED_OUT',session())};
export const supabase={supabaseUrl:'https://offline-project.example.test',rpc(name,payload){
if(name!=='get_patient_avatar_urls'){window.requestDetailsTest.backendCalls++;throw new Error('Unexpected backend mutation')}
state.rpcCalls.push(payload.p_patient_ids);const result={data:payload.p_patient_ids.map(id=>({patient_id:id,avatar_url:state.paths[id]||''})),error:state.mode==='rpc-error'?{message:'Synthetic denial'}:null};if(state.holdFirst){state.holdFirst=false;return new Promise(resolve=>{state.releasePhotos=()=>resolve(result)})}return Promise.resolve(result)},
storage:{from(bucket){return{async download(path,options,parameters){state.downloads.push({bucket,path,options,cache:parameters.cache});
if(state.mode==='denied')return{data:null,error:{message:'Synthetic storage denial'}};
const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
return{data:new Blob([state.mode==='broken'?'not an image':bytes],{type:'image/png'}),error:null}}}}},
auth:{getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(f){listeners.add(f);return{data:{subscription:{unsubscribe(){listeners.delete(f)}}}}},getUser(){throw new Error('Unexpected authentication request')}}};`;
  },
}, react()], build: { write: false, minify: false, lib: { entry: 'request-details-test.jsx', formats: ['es'] } } });
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(value => value.output);
const code = outputs.find(value => value.type === 'chunk').code.replaceAll('</script', '<\\/script');
const css = postcss.parse(outputs.filter(value => value.type === 'asset' && value.fileName.endsWith('.css')).map(value => value.source).join('\n'));
css.walkAtRules('import', rule => rule.remove());
const temporary = await mkdtemp(join(tmpdir(), 'maternal-staff-request-details-'));
const html = join(temporary, 'fixture.html');
await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${code}</script>`);
const candidates = process.env.HEADLESS_BROWSER ? [process.env.HEADLESS_BROWSER] : ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'];
let executable;
for (const path of candidates) { try { await access(path); executable = path; break; } catch { /* Try next installation. */ } }
assert.ok(executable, 'Installed Chrome/Chromium required');
const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, 'browser-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let socket, cdp;
try {
  let port;
  for (let n = 0; n < 100 && !port; n++) { try { port = (await readFile(join(temporary, 'browser-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(); } }
  assert.ok(port, 'Offline browser starts');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('Browser command timeout: ' + method)); }, 5000).unref();
  });
  const evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails)); return response.result.value;
  };
  const until = async expression => { for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await pause(); } throw new Error('Wait timed out: ' + expression); };
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector('${selector}');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const key = async value => {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Tab: 9 }[value];
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode, text: value === 'Enter' ? '\r' : undefined });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode });
  };
  const screenshot = async name => {
    const result = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(temporary, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  await cdp('Network.enable'); await cdp('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  for (const [width, height] of [[320,568],[390,844],[768,1024],[1024,768],[1440,900]]) {
    const before = assertions;
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: pathToFileURL(html).href }); await until('!!document.querySelector(".doctor-request-information-card")');
    await until('!!window.requestDetailsTest.state.releasePhotos');
    check(await evaluate("!!document.querySelector('.doctor-request-detail-avatar .staff-request-avatar-placeholder')&&document.querySelector('.doctor-request-detail-avatar').getAttribute('aria-busy')==='true'&&!document.querySelector('.doctor-request-detail-avatar').textContent.trim()"), width + ': genuine first load uses neutral pending placeholder');
    await evaluate('window.requestDetailsTest.state.releasePhotos()');
    await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    for (const long of [false, true]) {
      await evaluate(`window.requestDetailsTest.setLong(${long})`); await pause();
      const geometry = await evaluate(`(()=>{const page=document.querySelector('.doctor-request-details-page');const nodes=[page,...page.querySelectorAll('section,dl,dt,dd,h2,.doctor-request-patient-identity,.doctor-request-patient-contact,.doctor-request-patient-contact span,.doctor-request-patient-identity span,footer,footer button')];return {overflow:nodes.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className||e.tagName),outside:nodes.filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth+1}).map(e=>e.className||e.tagName),rowWidths:[...page.querySelectorAll('dt')].map(e=>e.getBoundingClientRect().width),cardPadding:getComputedStyle(page.querySelector('section')).paddingTop,buttons:[...page.querySelectorAll('footer button')].map(e=>({h:e.getBoundingClientRect().height,disabled:e.disabled})),pageWidth:document.documentElement.scrollWidth}})()`);
      check(geometry.overflow.length === 0, width + ': no clipped normal/long values: ' + JSON.stringify(geometry.overflow));
      check(geometry.outside.length === 0 && geometry.pageWidth <= width + 1, width + ': no page-wide overflow: ' + JSON.stringify(geometry.outside));
      check(geometry.buttons.every(button => button.h >= 44), width + ': touch-size actions');
      check(geometry.rowWidths.every(value => Math.abs(value - geometry.rowWidths[0]) < 1), width + ': shared label alignment');
      check(Number.parseFloat(geometry.cardPadding) <= 24, width + ': compact card padding');
      check(await evaluate(`(()=>{const row=document.querySelector('.staff-request-doctor-row'),icon=row.querySelector('.staff-request-doctor-trigger > svg'),nearby=document.querySelector('.doctor-request-information-card dd > svg'),a=icon.getBoundingClientRect(),b=nearby.getBoundingClientRect(),label=row.querySelector('dt').getBoundingClientRect();return Math.abs(a.left-b.left)<1&&a.width===b.width&&a.height===b.height&&(innerWidth<=480||Math.abs(a.top+a.height/2-label.top-label.height/2)<1)})()`), width + ': Doctor icon matches adjacent icon column and row center');
      check(await evaluate(`(()=>{const cards=[...document.querySelectorAll('.doctor-request-details-page > section')];return cards.every((e,i)=>!i||e.getBoundingClientRect().top>=cards[i-1].getBoundingClientRect().bottom)})()`), width + ': cards never overlap');
      if (!long) await screenshot(width + '-top');
      check(await evaluate("document.querySelector('.doctor-request-approve-button').disabled"), width + ': approval requires Doctor');
      await click('.staff-request-doctor-trigger'); await until('!!document.querySelector(".staff-request-doctor-menu")');
      check(await evaluate(`(()=>{const e=document.querySelector('.staff-request-doctor-menu');return e.scrollWidth<=e.clientWidth+1&&e.getBoundingClientRect().right<=innerWidth+1})()`), width + ': Doctor menu fits');
      await click('.staff-request-doctor-menu > button:last-child'); await until("window.requestDetailsTest.events.at(-1)?.[1]==='doctor-b'");
      check(await evaluate("document.activeElement===document.querySelector('.staff-request-doctor-trigger')&&!document.querySelector('.doctor-request-approve-button').disabled"), width + ': Doctor selection and return focus');
      check(await evaluate("document.querySelector('.staff-request-doctor-trigger').scrollWidth<=document.querySelector('.staff-request-doctor-trigger').clientWidth+1"), width + ': selected long Doctor name fits');
      await click('.doctor-request-back-button'); check(await evaluate("window.requestDetailsTest.events.at(-1)[0]==='back'"), width + ': original Back callback');
      await click('.doctor-request-decline-button'); check(await evaluate("window.requestDetailsTest.events.at(-1).join('|')==='decline|offline-request'"), width + ': exact Decline target');
      await click('.doctor-request-approve-button'); check(await evaluate("window.requestDetailsTest.events.at(-1).join('|')==='approve|offline-request'"), width + ': exact Approve target');
      await evaluate("window.requestDetailsTest.setBusy(true);window.requestDetailsTest.setError('Unable to approve: '+'LongSyntheticError'.repeat(12))"); await pause();
      check(await evaluate("['.staff-request-doctor-trigger','.doctor-request-decline-button','.doctor-request-approve-button'].every(s=>document.querySelector(s).disabled)"), width + ': original busy guards');
      check(await evaluate("(()=>{const e=document.querySelector('[role=alert]');return !!e&&e.scrollWidth<=e.clientWidth+1})()"), width + ': readable error');
      await evaluate("window.requestDetailsTest.setBusy(false);window.requestDetailsTest.setDoctor('');window.requestDetailsTest.setError('')"); await pause();
    }
    await evaluate("window.requestDetailsTest.setLong(false);document.querySelector('.staff-request-doctor-trigger').focus()"); await pause();
    await key('Enter'); await until('!!document.querySelector(".staff-request-doctor-menu")');
    await key('Tab');
    check(await evaluate("document.activeElement.matches('.staff-request-doctor-menu > button')"), width + ': Doctor options reachable by keyboard');
    await key('Escape'); await until('!document.querySelector(".staff-request-doctor-menu")');
    check(await evaluate("document.activeElement===document.querySelector('.staff-request-doctor-trigger')"), width + ': Escape restores Doctor trigger');
    await evaluate("document.querySelector('.doctor-request-status-card').scrollIntoView({block:'end'})");
    await screenshot(width + '-footer');
    await click('.doctor-request-message-button'); await until('!!document.querySelector("[role=dialog]")');
    check(await evaluate("document.querySelector('[role=dialog]').textContent.includes('Appointment request update')"), width + ': real Message Patient dialog opens with original defaults');
    await key('Escape');
    await until('!document.querySelector("[role=dialog]")');
    await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    const originalPhoto = await evaluate("document.querySelector('.doctor-request-detail-avatar img').src");
    check(originalPhoto.startsWith('blob:'), width + ': detail photo uses authenticated blob');
    await evaluate("window.requestDetailsTest.setScreen('list')");
    await until('!!document.querySelector(".doctor-request-patient img")?.naturalWidth');
    check(await evaluate(`document.querySelector('.doctor-request-patient img').src===${JSON.stringify(originalPhoto)}`), width + ': identical photo in list and details');
    const navigationReads = await evaluate('window.requestDetailsTest.state.rpcCalls.length');
    const navigationDownloads = await evaluate('window.requestDetailsTest.state.downloads.length');
    await evaluate('window.requestDetailsTest.monitorPhotos=true;window.requestDetailsTest.flashes=0');
    for (let n=0;n<4;n++) {
      await evaluate("window.requestDetailsTest.setScreen('all')"); await pause();
      await evaluate("window.requestDetailsTest.setScreen('list')"); await pause();
      check(await evaluate(`document.querySelector('.doctor-request-patient img')?.src===${JSON.stringify(originalPhoto)}&&!document.querySelector('.doctor-request-patient .staff-request-avatar-placeholder')`), width + ': All/Requests retains verified image on return');
    }
    await evaluate("window.requestDetailsTest.state.auth('staff-a','session-a')"); await pause();
    check(await evaluate(`document.querySelector('.doctor-request-patient img')?.src===${JSON.stringify(originalPhoto)}&&window.requestDetailsTest.state.downloads.length===${navigationDownloads}&&window.requestDetailsTest.state.rpcCalls.length===${navigationReads}`), width + ': navigation/auth object refresh makes no redundant avatar requests');
    check(await evaluate("JSON.stringify([...document.querySelector('.doctor-request-sort select').options].map(o=>[o.value,o.text]))===JSON.stringify([['newest','Newest First'],['oldest','Oldest First']])"), width + ': exactly two sorting options rendered');
    check(await evaluate("document.querySelector('.doctor-request-sort select').value==='newest'"), width + ': Newest First selected by default');
    for (const option of ['newest','oldest']) {
      await evaluate(`(()=>{const s=document.querySelector('.doctor-request-sort select');s.value='${option}';s.dispatchEvent(new Event('change',{bubbles:true}));s.focus()})()`); await pause();
      check(await evaluate(`window.requestDetailsTest.events.at(-1).join('|')==='sort|${option}'`), width + ': original sort handler receives ' + option);
      check(await evaluate(`(()=>{const s=document.querySelector('.doctor-request-sort select'),a=s.parentElement.querySelector('svg'),c=getComputedStyle(s),r=s.getBoundingClientRect(),ar=a.getBoundingClientRect(),ctx=document.createElement('canvas').getContext('2d');ctx.font=c.fontWeight+' '+c.fontSize+' '+c.fontFamily;const text=ctx.measureText(s.selectedOptions[0].text).width;return text<=s.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight)&&r.left+parseFloat(c.paddingLeft)+text+8<=ar.left&&Math.abs(ar.top+ar.height/2-r.top-r.height/2)<1&&s.clientWidth>=180&&getComputedStyle(a).position==='absolute'&&getComputedStyle(a).pointerEvents==='none'})()`), width + ': full selected label and separate arrow: ' + option);
      check(await evaluate("getComputedStyle(document.querySelector('.doctor-request-sort')).boxShadow!=='none'"), width + ': visible sort focus state');
    }
    check(await evaluate("(()=>{const nodes=['.doctor-request-tools','.doctor-request-search','.doctor-request-sort'];return document.documentElement.scrollWidth<=innerWidth+1&&nodes.every(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1})})()"), width + ': search and sort stay within local layout');
    await evaluate("document.querySelector('.doctor-request-tools').scrollIntoView({block:'start'})"); await screenshot(width + '-sort');
    check(await evaluate("!document.querySelectorAll('.doctor-request-patient')[1].querySelector('img')&&document.querySelectorAll('.doctor-request-patient')[1].textContent.includes('S')"), width + ': same-name patient without photo retains own initials');
    await click('.doctor-request-view'); await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    check(await evaluate(`document.querySelector('.doctor-request-detail-avatar img').src===${JSON.stringify(originalPhoto)}`), width + ': View reuses verified image without duplicate download');
    await evaluate('window.requestDetailsTest.navigateBack=true'); await click('.doctor-request-back-button');
    await until('!!document.querySelector(".doctor-request-patient img")');
    check(await evaluate(`document.querySelector('.doctor-request-patient img').src===${JSON.stringify(originalPhoto)}`), width + ': Back retains the same list image');
    await click('.doctor-request-view'); await until('!!document.querySelector(".doctor-request-detail-avatar img")');
    check(await evaluate('window.requestDetailsTest.flashes===0'), width + ': DOM observation finds no initials or placeholder during known-photo navigation');
    await evaluate("window.requestDetailsTest.setScreen('list');window.requestDetailsTest.nextScreen='all'"); await pause();
    const routeMounts = await evaluate('window.requestDetailsTest.mounts');
    const routeReads = await evaluate('window.requestDetailsTest.state.rpcCalls.length');
    const routeDownloads = await evaluate('window.requestDetailsTest.state.downloads.length');
    for (let cycle=0;cycle<3;cycle++) for (const page of ['dashboard','patients']) {
      await evaluate(`window.requestDetailsTest.navigate('/staff/${page}')`); await until(`!!document.querySelector('[data-route="${page}"]')`);
      await evaluate("window.requestDetailsTest.state.auth('staff-a','session-a')");
      await evaluate("window.requestDetailsTest.navigate('/staff/appointments')"); await until("window.requestDetailsTest.path==='/staff/appointments'&&!!document.querySelector('.staff-appointments-page')");
      await evaluate("window.requestDetailsTest.setScreen('list')"); await until('!!document.querySelector(".doctor-request-patient")');
      check(await evaluate(`document.querySelector('.doctor-request-patient img')?.src===${JSON.stringify(originalPhoto)}&&!document.querySelector('.doctor-request-patient .staff-request-avatar-placeholder')`), width + ': route remount preserves photo after ' + page + ' cycle ' + cycle);
    }
    check(await evaluate(`window.requestDetailsTest.mounts===${routeMounts+6}&&window.requestDetailsTest.unmounts===6`), width + ': actual React Router route changes unmount/remount Appointments six times');
    check(await evaluate('!window.requestDetailsTest.commitFlashes&&window.requestDetailsTest.flashes===0'), width + ': every known-photo React commit remains free of placeholders across full page navigation');
    check(await evaluate(`window.requestDetailsTest.state.rpcCalls.length===${routeReads}&&window.requestDetailsTest.state.downloads.length===${routeDownloads}`), width + ': full page navigation and detached same-session Auth refresh reuse cached bytes');
    await click('.doctor-request-view'); await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    await evaluate("delete window.requestDetailsTest.nextScreen");
    await evaluate('window.requestDetailsTest.monitorPhotos=false;window.requestDetailsTest.navigateBack=false');
    const beforeRefresh = await evaluate('window.requestDetailsTest.state.rpcCalls.length');
    await evaluate("window.requestDetailsTest.state.paths['11111111-1111-4111-8111-111111111111']='linked-patient-user/new-avatar';window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))");
    await until(`document.querySelector('.doctor-request-detail-avatar img')?.src!==${JSON.stringify(originalPhoto)}`);
    check(await evaluate(`window.requestDetailsTest.state.rpcCalls.length===${beforeRefresh + 1}`), width + ': focus/visibility refresh coalesced and latest bytes fetched');
    check(await evaluate("window.requestDetailsTest.state.downloads.at(-1).path==='linked-patient-user/new-avatar'"), width + ': latest saved reference used on refresh');
    const detachedPhoto = await evaluate("document.querySelector('.doctor-request-detail-avatar img').src");
    await evaluate("window.requestDetailsTest.navigate('/staff/dashboard')"); await until("!!document.querySelector('[data-route=dashboard]')");
    const detachedReads = await evaluate('window.requestDetailsTest.state.rpcCalls.length');
    await evaluate("window.requestDetailsTest.state.paths['11111111-1111-4111-8111-111111111111']='linked-patient-user/updated-while-away';window.dispatchEvent(new Event('profile-picture-updated'))"); await pause();
    check(await evaluate(`window.requestDetailsTest.state.rpcCalls.length===${detachedReads}&&!window.requestDetailsTest.revokedUrls.includes(${JSON.stringify(detachedPhoto)})`), width + ': photo update while Appointments unmounted defers reads and preserves URL');
    await evaluate("window.requestDetailsTest.navigate('/staff/appointments')"); await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    await until(`document.querySelector('.doctor-request-detail-avatar img')?.src!==${JSON.stringify(detachedPhoto)}`);
    check(await evaluate(`window.requestDetailsTest.state.downloads.at(-1).path==='linked-patient-user/updated-while-away'&&window.requestDetailsTest.revokedUrls.includes(${JSON.stringify(detachedPhoto)})`), width + ': authoritative update after remount replaces photo and releases prior URL');
    const removedPhoto = await evaluate("document.querySelector('.doctor-request-detail-avatar img').src");
    await evaluate("window.requestDetailsTest.navigate('/staff/patients')"); await until("!!document.querySelector('[data-route=patients]')");
    await evaluate("window.requestDetailsTest.state.paths['11111111-1111-4111-8111-111111111111']='';window.dispatchEvent(new Event('profile-picture-updated'))"); await pause();
    await evaluate("window.requestDetailsTest.navigate('/staff/appointments')"); await until("document.querySelector('.doctor-request-detail-avatar')?.textContent==='SP'");
    check(await evaluate(`!document.querySelector('.doctor-request-detail-avatar img')&&window.requestDetailsTest.revokedUrls.includes(${JSON.stringify(removedPhoto)})`), width + ': authoritative removal while page detached clears photo on return');
    await evaluate("window.requestDetailsTest.setPatient('22222222-2222-4222-8222-222222222222')");
    await until("!document.querySelector('.doctor-request-detail-avatar img')");
    check(await evaluate("document.querySelector('.doctor-request-detail-avatar').textContent==='SP'"), width + ': patient switch never shows previous photo');
    await evaluate("window.requestDetailsTest.state.paths['11111111-1111-4111-8111-111111111111']='linked-patient-user/restored';window.requestDetailsTest.setPatient('11111111-1111-4111-8111-111111111111');window.requestDetailsTest.state.auth('staff-a','replacement-session')");
    await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    await evaluate("window.requestDetailsTest.state.auth('staff-b','session-b');window.requestDetailsTest.setStaff('staff-b')");
    await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    await evaluate("window.requestDetailsTest.state.mode='denied';window.requestDetailsTest.state.auth('staff-b','denied-session')");
    await until("!document.querySelector('.doctor-request-detail-avatar img')");
    check(await evaluate("document.querySelector('.doctor-request-detail-avatar').textContent==='SP'"), width + ': inaccessible image uses initials');
    await evaluate("window.requestDetailsTest.state.mode='broken';window.requestDetailsTest.state.auth('staff-b','broken-session')");
    await until("window.requestDetailsTest.state.downloads.length>0&&!document.querySelector('.doctor-request-detail-avatar img')");
    // Allow the image decode/error event to run before checking the fallback.
    await pause();
    check(await evaluate("!document.querySelector('.doctor-request-detail-avatar img')&&document.querySelector('.doctor-request-detail-avatar').textContent==='SP'"), width + ': invalid image bytes gracefully fall back');
    await evaluate("window.requestDetailsTest.state.mode='success';window.requestDetailsTest.state.auth('staff-b','recovery-session')");
    await until('!!document.querySelector(".doctor-request-detail-avatar img")?.naturalWidth');
    check(await evaluate("!!document.querySelector('.doctor-request-detail-avatar img').naturalWidth"), width + ': fresh authorized load recovers');
    await evaluate("window.requestDetailsTest.setScreen('all')"); await pause();
    const pausedReads = await evaluate('window.requestDetailsTest.state.rpcCalls.length');
    await evaluate("window.requestDetailsTest.state.paths['11111111-1111-4111-8111-111111111111']='';window.dispatchEvent(new Event('profile-picture-updated'))"); await pause();
    check(await evaluate(`window.requestDetailsTest.state.rpcCalls.length===${pausedReads}`), width + ': background All view pauses avatar requests');
    await evaluate("window.requestDetailsTest.setScreen('details')");
    await until("document.querySelector('.doctor-request-detail-avatar')?.textContent==='SP'");
    check(await evaluate(`window.requestDetailsTest.state.rpcCalls.length===${pausedReads+1}&&!document.querySelector('.doctor-request-detail-avatar img')`), width + ': deferred refresh detects removed picture on return');
    await evaluate("window.requestDetailsTest.navigate('/staff/dashboard')"); await until("!!document.querySelector('[data-route=dashboard]')");
    await evaluate("window.requestDetailsTest.state.auth('', '');window.requestDetailsTest.nextStaff='staff-b'");
    check(await evaluate('window.requestDetailsTest.createdUrls.every(url=>window.requestDetailsTest.revokedUrls.includes(url))'), width + ': logout on another route releases every cached URL');
    await evaluate("window.requestDetailsTest.navigate('/staff/appointments')"); await until("document.querySelector('.doctor-request-detail-avatar')?.textContent==='SP'");
    check(await evaluate("!document.querySelector('.doctor-request-detail-avatar img')"), width + ': remount after logout cannot reuse old account photo');
    check(await evaluate('window.requestDetailsTest.backendCalls===0&&window.requestDetailsTest.errors.length===0'), width + ': no live writes or runtime errors');
    console.log(width + 'x' + height + ': ' + (assertions - before) + ' browser assertions passed');
  }
  console.log('Staff request details: ' + assertions + ' assertions passed (synthetic handler checks + offline browser rendering). Fixture: ' + temporary);
} finally {
  if (cdp) await cdp('Browser.close').catch(() => {}); if (socket) socket.close(); if (browser.exitCode === null) browser.kill();
}
