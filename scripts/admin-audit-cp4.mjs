// Checkpoint 4 only. Import/prepare never starts Docker, connects, or executes SQL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPackage } from '../docs/rehearsal/admin-audit-production/run.mjs';
import { composeFiles, validateComposeFiles, assertComposeRuntime, digest } from './admin-audit-cp4-compose.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sealed = path.join(root, 'docs/rehearsal/admin-audit-production');
const read = name => fs.readFileSync(path.join(sealed, name), 'utf8').replaceAll('\r\n', '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const roles = ['admin', 'doctor', 'staff', 'patient'];
export function localURL(value) {
  const url = new URL(value);
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port &&
    url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,
  'Only an explicit http://127.0.0.1:PORT local API is allowed');
  return url.origin;
}
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'Reviewed SQL section missing');
  return text.slice(a, b);
}
export function artifacts(nonce) {
  assert(/^[a-f0-9]{32}$/.test(nonce), 'Require a fresh 32-hex nonce');
  checkPackage(); // integrity only; does not repeat completed SQL tests
  const bootstrap = read('bootstrap.sql'), migration = read('migration.sql');
  let table = between(bootstrap, 'create table if not exists public.audit_logs (',
    'create or replace function public.is_active_admin_realtime()');
  const old = "status in ('success', 'failure', 'rejected')";
  assert.equal(table.split(old).length, 2);
  table = table.replace(old, "status in ('success', 'failure', 'rejected', 'reported')");
  const helper = between(bootstrap, 'create or replace function public.is_active_admin_realtime()',
    'create or replace function public.admin_user_management_assert_active_admin()');
  const writers = between(migration, 'create or replace function public.record_internal_audit_event(',
    '-- Change only the audit call in each verified Admin status transaction.');
  const broadcast = fs.readFileSync(path.join(root, 'supabase/migrations/20260928023000_admin_audit_log_broadcast.sql'), 'utf8')
    .replaceAll('\r\n', '\n').replace(/^begin;\s*/i, '').replace(/commit;\s*$/i, '');
  const config = `project_id = "mc-audit-cp4-${nonce}"
[experimental]
stack = true
[db]
major_version = 17
[db.seed]
enabled = false
[auth]
enable_signup = false
`;
  const sql = `-- NEW disposable local Supabase ONLY. Requires separate approval; never run on an existing database.
begin;
set local statement_timeout = '30s';
do $fresh$
begin
 if current_user <> 'postgres' or current_database() <> 'postgres'
    or current_setting('server_version_num')::int / 10000 <> 17
    or to_regclass('public.profiles') is not null or to_regclass('public.audit_logs') is not null
    or to_regclass('public.patients') is not null or to_regnamespace('rehearsal_control') is not null
    or to_regnamespace('s4audit_private') is not null
    or to_regprocedure('auth.uid()') is null
    or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
   raise exception 'Not a fresh CP4 Supabase target. STOP; never relax this guard.';
 end if;
end;
$fresh$;
create table public.profiles (
 id uuid primary key references auth.users(id), full_name text not null, email text not null,
 role text not null check(role in ('admin','doctor','staff','patient')),
 account_status text not null default 'active'
);
${table}${helper}${writers}
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from public,anon,authenticated,service_role;
grant select on public.audit_logs to authenticated;
create policy "Active admins can read audit logs" on public.audit_logs for select to authenticated
 using ((select public.is_active_admin_realtime()));
alter table public.profiles enable row level security;
revoke all on public.profiles from public,anon,authenticated,service_role;
grant select on public.profiles to authenticated;
grant select,insert on public.profiles to service_role;
create policy "Own synthetic profile" on public.profiles for select to authenticated using(id=(select auth.uid()));
revoke all on function public.is_active_admin_realtime() from public,anon;
grant execute on function public.is_active_admin_realtime() to authenticated;
${broadcast}
create view public.audit_cp4_identity as select '${nonce}'::text as nonce;
revoke all on public.audit_cp4_identity from public,anon,authenticated,service_role;
grant select on public.audit_cp4_identity to anon,authenticated;
notify pgrst, 'reload schema';
commit;
`;
  return { config, sql, writers, broadcast };
}
export function prepare(nonce) {
  const a = artifacts(nonce), workspace = path.join(os.tmpdir(), `mc-audit-cp4-${nonce}`);
  // Exclusive creation: never reuse or overwrite a prior run, including an uncertain run.
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'supabase'));
  fs.writeFileSync(path.join(workspace, 'supabase/config.toml'), a.config, { flag: 'wx' });
  fs.writeFileSync(path.join(workspace, 'setup.sql'), a.sql, { flag: 'wx' });
  fs.writeFileSync(path.join(workspace, 'plan.json'), JSON.stringify({ nonce, sqlHash: sha(a.sql), configHash: sha(a.config) }, null, 2), { flag: 'wx' });
  return workspace;
}
export function loadPlan(workspace) {
  const p = JSON.parse(fs.readFileSync(path.join(workspace, 'plan.json'), 'utf8'));
  assert(/^[a-f0-9]{32}$/.test(p.nonce), 'Invalid package nonce');
  if (p.runtime === 'docker-compose') {
    assert.equal(fs.realpathSync(workspace), fs.realpathSync(path.join(os.tmpdir(), `mc-audit-cp4-compose-${p.nonce}`)));
    const manifest = validateComposeFiles(p, name => fs.readFileSync(path.join(workspace, name), 'utf8'));
    assert.equal(fs.readFileSync(path.join(workspace, 'setup.sql'), 'utf8'), artifacts(p.nonce).sql, 'Audit SQL differs from passed candidate');
    return { ...p, manifest };
  }
  assert.equal(fs.realpathSync(workspace), fs.realpathSync(path.join(os.tmpdir(), `mc-audit-cp4-${p.nonce}`)));
  const a = artifacts(p.nonce);
  assert.equal(sha(a.sql), p.sqlHash); assert.equal(sha(a.config), p.configHash);
  assert.equal(sha(fs.readFileSync(path.join(workspace, 'setup.sql'))), p.sqlHash);
  assert.equal(sha(fs.readFileSync(path.join(workspace, 'supabase/config.toml'))), p.configHash);
  return p;
}
export function prepareCompose(nonce) {
  const { files } = composeFiles(nonce, artifacts(nonce).sql);
  const workspace = path.join(os.tmpdir(), `mc-audit-cp4-compose-${nonce}`);
  fs.mkdirSync(workspace); // exclusive creation; old CP4 projects and volumes are never adopted
  fs.mkdirSync(path.join(workspace, 'private'), { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), content, { flag: 'wx', mode: 0o600 });
  const plan = { version: 2, runtime: 'docker-compose', syntheticOnly: true, nonce,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])) };
  fs.writeFileSync(path.join(workspace, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
  loadPlan(workspace);
  return workspace;
}
// Explicitly approved READ-ONLY Docker inspection only; never starts or changes a resource.
export async function inspectCompose(workspace) {
  const p = loadPlan(workspace); assert.equal(p.runtime, 'docker-compose');
  const { execFileSync } = await import('node:child_process');
  const docker = args => {
    try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }); }
    catch { throw Error('Targeted Docker inspection failed; no Docker stderr/environment printed.'); }
  };
  const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert(/^(npipe|unix):\/\//.test(endpoint) && (!process.env.DOCKER_HOST || /^(npipe|unix):\/\//.test(process.env.DOCKER_HOST)), 'Local Docker socket required');
  const names = ['db', 'auth', 'rest', 'realtime', 'kong'].map(s => `${p.manifest.project}-${s}-1`);
  const projectFilter = ['--filter', `label=com.docker.compose.project=${p.manifest.project}`];
  const list = args => docker(args).trim().split(/\r?\n/).filter(Boolean);
  const resources = {
    containers: list(['ps', '-a', ...projectFilter, '--format', '{{.Names}}']),
    networks: list(['network', 'ls', ...projectFilter, '--format', '{{.Name}}']),
    volumes: list(['volume', 'ls', ...projectFilter, '--format', '{{.Name}}']),
  };
  const raw = JSON.parse(docker(['inspect', ...names]));
  const networks = JSON.parse(docker(['network', 'inspect', p.manifest.network, p.manifest.gatewayNetwork]));
  const volume = JSON.parse(docker(['volume', 'inspect', p.manifest.volume]))[0];
  const inspection = { inspectedAt: new Date().toISOString(), localSocket: true, resources,
    networks: networks.map(net => ({ Name: net.Name, Driver: net.Driver, Internal: net.Internal,
      project: net.Labels?.['com.docker.compose.project'], nonce: net.Labels?.['maternal.audit.cp4.nonce'],
      Containers: Object.values(net.Containers || {}).map(c => c.Name) })),
    volume: { Name: volume.Name, nonce: volume.Labels?.['maternal.audit.cp4.nonce'] },
    containers: raw.map(c => ({ name: c.Name.slice(1), service: c.Config.Labels?.['com.docker.compose.service'],
      nonce: c.Config.Labels?.['maternal.audit.cp4.nonce'], image: c.Config.Image, running: c.State.Running, healthy: c.State.Health?.Status === 'healthy',
      networks: Object.keys(c.NetworkSettings.Networks), volumes: c.Mounts.filter(m => m.Type === 'volume').map(m => m.Name),
      bindings: Object.entries(c.NetworkSettings.Ports || {}).flatMap(([target, list]) => (list || []).map(b => ({ host: b.HostIp, port: b.HostPort, target }))),
      binds: c.Mounts.filter(m => m.Type === 'bind').map(m => ({ source: m.Source, destination: m.Destination, readOnly: !m.RW })) })) };
  assertComposeRuntime(p.manifest, inspection, workspace);
  const dir = path.join(workspace, 'inspections'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify(inspection, null, 2), { flag: 'wx' });
  console.log('PASS: five healthy nonce-owned services; internal bridge plus Kong-only gateway; one effective localhost publication; fresh volume. No secrets exported.');
}
export function guardedFetch(origin, transport = fetch) {
  return (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin, 'Remote request refused');
    return transport(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  };
}
export function denial(result, codes = ['42501']) {
  assert(result.error && codes.includes(result.error.code), `Expected authorization denial; got ${result.error?.code || 'success'}`);
}
export function privateDenial(result) {
  denial(result, ['42501', 'PGRST202']);
  assert(result.error.code === 'PGRST202' || /permission denied for function/i.test(result.error.message || ''),
    'An internal business/auth validation error is not proof of a revoked execute grant');
}
async function connection(workspace) {
  const plan = loadPlan(workspace), origin = localURL(process.env.MC_CP4_URL);
  if (plan.runtime === 'docker-compose') {
    assert.equal(origin, plan.manifest.apiOrigin, 'API origin differs from the sealed runtime');
    const dir = path.join(workspace, 'inspections');
    const last = fs.readdirSync(dir).filter(name => /^[0-9]+\.json$/.test(name)).sort((a,b) => Number(b.slice(0,-5)) - Number(a.slice(0,-5)))[0];
    assert(last, 'Approved runtime inspection required before API access');
    const inspection = JSON.parse(fs.readFileSync(path.join(dir, last), 'utf8'));
    const age = Date.now() - Date.parse(inspection.inspectedAt);
    assert(age >= 0 && age <= 300000, 'Runtime inspection expired; request a fresh read-only inspection');
    assertComposeRuntime(plan.manifest, inspection, workspace);
  }
  const anon = process.env.MC_CP4_ANON_KEY;
  assert(anon, 'Local anon key required in process environment');
  const transport = guardedFetch(origin);
  const response = await transport(`${origin}/rest/v1/audit_cp4_identity?select=nonce`, { headers: { apikey: anon } });
  assert.equal(response.status, 200, 'Local SQL setup/marker not ready');
  assert.deepEqual(await response.json(), [{ nonce: plan.nonce }], 'Wrong local instance');
  const { createClient } = await import('@supabase/supabase-js');
  const client = key => createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
  return { ...plan, origin, anon, client, transport };
}
export async function verify(workspace) {
  const c = await connection(workspace), key = process.env.MC_CP4_SERVICE_KEY;
  assert(key, 'Local service key required only for creating synthetic identities');
  fs.writeFileSync(path.join(workspace, 'verify-started'), new Date().toISOString(), { flag: 'wx' });
  const service = c.client(key), users = [], receipts = new Map();
  let checks = 0;
  const ok = (condition, label) => { assert(condition, label); checks++; };
  const accepted = result => { assert.ifError(result.error); return result.data; };
  const claim = (u, action = 'login') => ({ p_module: 'authentication', p_action: action, p_entity_type: 'auth_user', p_entity_id: u.id, p_description: 'Synthetic CP4 authentication report.', p_metadata: {} });
  const record = async (u, args) => {
    const id = accepted(await u.api.rpc('record_audit_event', args));
    ok(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id), 'UUID receipt'); receipts.set(id, u.id); return id;
  };
  try {
    for (const role of roles) {
      const email = `cp4-${role}-${c.nonce}@example.invalid`, password = crypto.randomBytes(24).toString('base64url');
      const user = accepted(await service.auth.admin.createUser({ email, password, email_confirm: true })).user;
      accepted(await service.from('profiles').insert({ id: user.id, full_name: `Synthetic CP4 ${role}`, email, role, account_status: 'active' }));
      const api = c.client(c.anon), session = accepted(await api.auth.signInWithPassword({ email, password })).session;
      ok(accepted(await api.auth.getUser()).user.id === user.id && !!session.access_token, `${role}: real Auth JWT`);
      users.push({ id: user.id, role, email, password, api });
    }
    // Synthetic passwords only, outside repo. No API keys or JWTs written. Do not share this file.
    fs.writeFileSync(path.join(workspace, 'synthetic-logins.json'), JSON.stringify(users.map(({ id, role, email, password }) => ({ id, role, email, password })), null, 2), { flag: 'wx', mode: 0o600 });
    const admin = users[0];
    for (const u of users) {
      const id = await record(u, claim(u)); await record(u, claim(u, 'logout'));
      denial(await u.api.rpc('record_audit_event', { ...claim(u), p_entity_id: users.find(x => x.id !== u.id).id })); checks++;
      for (const [module, action] of [['patient_management', 'register'], ['appointment_management', 'create'], ['visit_records', 'complete'], ['system_settings', 'settings_update']]) {
        denial(await u.api.rpc('record_audit_event', { ...claim(u), p_module: module, p_action: action })); checks++;
      }
      const payload = { actor_user_id: u.id, actor_name: 'Synthetic', actor_role: u.role, module: 'authentication', action: 'login', status: 'success', description: 'Forbidden direct write.' };
      for (const request of [u.api.from('audit_logs').insert(payload), u.api.from('audit_logs').update({ description: 'Forbidden update.' }).eq('id', id), u.api.from('audit_logs').delete().eq('id', id)]) {
        denial(await request); checks++;
      }
      privateDenial(await u.api.rpc('record_internal_audit_event', { ...claim(u), p_status: 'reported' })); checks++;
      const report = { p_module: 'reports', p_action: 'export', p_entity_type: 'report', p_entity_id: 'appointment-summary-2026-10-01-to-2026-10-18', p_description: 'Synthetic report.', p_metadata: { report: 'Appointment Summary Report', format: 'pdf' } };
      if (u.role === 'admin') {
        for (const format of ['pdf', 'excel', 'print']) await record(u, { ...report, p_action: format === 'print' ? 'print' : 'export', p_metadata: { ...report.p_metadata, format } });
      } else { denial(await u.api.rpc('record_audit_event', report)); checks++; }
      if (u.role !== 'admin') ok(accepted(await u.api.from('audit_logs').select('id')).length === 0, `${u.role}: RLS empty result`);
    }
    privateDenial(await service.rpc('record_internal_audit_event', { ...claim(admin), p_status: 'reported' })); checks++;
    denial(await c.client(c.anon).rpc('record_audit_event', claim(admin)), ['42501', 'PGRST301', 'PGRST302']); checks++;
    const malformed = await c.transport(`${c.origin}/rest/v1/audit_logs?select=id`, { headers: { apikey: c.anon, Authorization: 'Bearer invalid-cp4-jwt' } });
    ok(malformed.status === 401, 'Malformed JWT rejected');
    for (const u of users) {
      const session = accepted(await u.api.auth.getSession()).session;
      await u.api.realtime.setAuth(session.access_token);
      let received = false;
      const channel = u.api.channel('admin:audit-logs', { config: { private: true } })
        .on('broadcast', { event: 'audit_log_changed' }, message => {
          if (message.payload?.operation === 'INSERT' && Object.keys(message.payload).sort().join(',') === 'id,operation') received = true;
        });
      const status = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`${u.role}: Realtime inconclusive (timeout)`)), 15000);
        channel.subscribe((state, error) => {
          if (state === 'SUBSCRIBED' || state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
            clearTimeout(timer); resolve({ state, message: String(error?.message || '') });
          }
        });
      });
      if (u.role === 'admin') {
        ok(status.state === 'SUBSCRIBED', 'Admin private subscription');
        await record(u, claim(u));
        for (let i = 0; i < 50 && !received; i++) await new Promise(resolve => setTimeout(resolve, 100));
        ok(received, 'Actual INSERT invalidation delivered without record payload');
        accepted(await u.api.auth.refreshSession());
        await u.api.realtime.setAuth(accepted(await u.api.auth.getSession()).session.access_token);
        received = false; await record(u, claim(u));
        for (let i = 0; i < 50 && !received; i++) await new Promise(resolve => setTimeout(resolve, 100));
        ok(received, 'Real refreshed JWT retains Admin delivery');
      } else {
        ok(status.state === 'CHANNEL_ERROR' && /permission|authoriz|policy|access/i.test(status.message), `${u.role}: explicit private-channel denial (timeout is not proof)`);
      }
      await u.api.removeChannel(channel);
    }
    const rows = accepted(await admin.api.from('audit_logs').select('id,actor_user_id,status,metadata,module,action'));
    ok(rows.length === receipts.size, 'Denied requests created no events; direct writes changed no count');
    for (const row of rows) ok(receipts.get(row.id) === row.actor_user_id && row.status === 'reported' && row.metadata.event_source === 'client_reported' && ['authentication', 'reports'].includes(row.module), 'Server-derived identity/source/outcome');
    fs.writeFileSync(path.join(workspace, 'verify-passed.json'), JSON.stringify({ checks, events: rows.length }), { flag: 'wx' });
    console.log(`PASS ${checks} live local assertions; ${rows.length} synthetic events. No production access.`);
  } finally {
    for (const u of users) { await u.api.removeAllChannels(); u.api.realtime.disconnect(); }
    service.realtime.disconnect();
  }
}

export function viewerSource(origin, anon, nonce) {
  const base = root.replaceAll('\\', '/');
  return {
    client: `import {createClient} from '@supabase/supabase-js';export const supabase=createClient(${JSON.stringify(origin)},${JSON.stringify(anon)},{auth:{storageKey:'cp4-${nonce}'}});`,
    entry: `import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';
import{AdminAuthProvider}from'${base}src/context/AdminAuthContext.jsx';import Page from'${base}src/pages/admin/AdminAuditLogs.jsx';import{supabase}from'cp4-client';
function Harness(){const[status,setStatus]=React.useState('Use synthetic-logins.json from the temporary workspace.');
async function run(task){try{const result=await task();if(result.error)throw result.error;setStatus('Completed.');}catch(e){setStatus(e.code||'Request failed');}}
return <><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);run(()=>supabase.auth.signInWithPassword({email:f.get('email'),password:f.get('password')}));}}><label>Email<input name="email" type="email" required/></label><label>Password<input name="password" type="password" required/></label><button>Sign in</button></form>
<button onClick={()=>run(()=>supabase.auth.signOut())}>Sign out</button><button onClick={()=>run(async()=>{const{data,error}=await supabase.auth.getUser();if(error)throw error;return supabase.rpc('record_audit_event',{p_module:'authentication',p_action:'login',p_entity_type:'auth_user',p_entity_id:data.user.id,p_description:'Synthetic viewer test.',p_metadata:{}});})}>Create own local audit report</button><p>{status}</p><Page/></>;}
createRoot(document.getElementById('root')).render(<BrowserRouter><AdminAuthProvider><Harness/></AdminAuthProvider></BrowserRouter>);`
  };
}
export async function viewer(workspace) {
  const c = await connection(workspace);
  assert(fs.existsSync(path.join(workspace, 'verify-passed.json')), 'Run approved local API checks first');
  const { createServer } = await import('vite'), { default: react } = await import('@vitejs/plugin-react');
  const source = viewerSource(c.origin, c.anon, c.nonce);
  const server = await createServer({ root, configFile: false, envFile: false, plugins: [{ name: 'cp4-only', enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('cp4-entry.jsx')) return '\0cp4-entry.jsx';
      if (id === 'cp4-client' || /\/supabaseClient(?:\.js)?$/.test(id)) return '\0cp4-client';
    },
    load(id) { if (id === '\0cp4-entry.jsx') return source.entry; if (id === '\0cp4-client') return source.client; },
    configureServer(s) { s.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/') return next();
      res.setHeader('Content-Type', 'text/html');
      // transformIndexHtml supplies the React development preamble for this isolated entry.
      s.transformIndexHtml('/', '<!doctype html><div id="root"></div><script type="module" src="/@id/__x00__cp4-entry.jsx"></script>')
        .then(html => res.end(html)).catch(next);
    }); }
  }, react()], server: { host: '127.0.0.1', port: 58973, strictPort: true, open: false }, css: { postcss: { plugins: [] } } });
  await server.listen(); console.log('Synthetic-only Audit Logs harness: http://127.0.0.1:58973');
}
const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const [mode, value, approval, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'Unexpected arguments');
  if (mode === 'prepare') { assert.equal(approval, 'PREPARE_CP4_FILES'); console.log(prepare(value)); }
  else if (mode === 'prepare-compose') { assert.equal(approval, 'PREPARE_CP4_COMPOSE_FILES'); console.log(prepareCompose(value)); }
  else if (mode === 'inspect-compose') { assert.equal(approval, 'INSPECT_NEW_COMPOSE_RUNTIME'); await inspectCompose(value); }
  else if (mode === 'verify') { assert.equal(approval, 'CREATE_LOCAL_SYNTHETIC_USERS_AND_TEST'); await verify(value); }
  else if (mode === 'viewer') { assert.equal(approval, 'OPEN_LOCAL_AUDIT_VIEWER'); await viewer(value); }
  else throw Error('Use prepare/prepare-compose NONCE or inspect-compose/verify/viewer WORKSPACE with the separately approved phase interlock. See runbook.');
}
