// Offline only: no Docker, SQL execution, Auth users, HTTP, or browser launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifacts, roles, localURL, guardedFetch, denial, privateDenial, viewerSource, prepareCompose, loadPlan } from './admin-audit-cp4.mjs';
import { composeDefinition, composeFiles, validateComposeFiles, digest, startupHash, assetDir } from './admin-audit-cp4-compose.mjs';
import os from 'node:os';
import crypto from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { assertCp4KeyContracts } from './verify-admin-audit-cp4-keys.mjs';
import { assertCp4NetworkContracts } from './verify-admin-audit-cp4-networks.mjs';

let checks = 0;
const check = condition => { assert(condition); checks++; };
const rejects = fn => { assert.throws(fn); checks++; };
const root = fileURLToPath(new URL('../', import.meta.url));
const nonce = '0123456789abcdef0123456789abcdef';
const a = artifacts(nonce);
check(roles.join(',') === 'admin,doctor,staff,patient');
check(localURL('http://127.0.0.1:22000') === 'http://127.0.0.1:22000');
for (const url of ['https://production.supabase.co', 'http://localhost:22000', 'http://127.0.0.1', 'http://127.0.0.1:22000/path', 'http://user:pass@127.0.0.1:22000', 'http://127.0.0.1:22000?x=y', 'http://127.0.0.1:22000#x', 'http://[::1]:22000']) rejects(() => localURL(url));
for (const invalid of ['../production', '', nonce + 'x', nonce.toUpperCase()]) rejects(() => artifacts(invalid));
let calls = 0;
const guarded = guardedFetch('http://127.0.0.1:22000', async (_url, init) => {
  check(init.redirect === 'error' && init.signal instanceof AbortSignal); calls++; return { status: 200 };
});
rejects(() => guarded('https://production.supabase.co/rest/v1/audit_logs'));
rejects(() => guarded('http://127.0.0.1:22001/rest/v1/audit_logs'));
check((await guarded('http://127.0.0.1:22000/rest/v1/audit_logs')).status === 200 && calls === 1);
for (const code of ['42501', 'PGRST202']) { denial({ error: { code } }, ['42501', 'PGRST202']); checks++; }
for (const code of ['08006', 'PGRST000', '500', 'ECONNRESET']) rejects(() => denial({ error: { code } }));
rejects(() => denial({ data: [] }));
privateDenial({ error: { code: '42501', message: 'permission denied for function record_internal_audit_event' } }); checks++;
privateDenial({ error: { code: 'PGRST202' } }); checks++;
for (const message of ['Authentication is required.', 'Unsupported authoritative audit event.', 'An active authenticated profile is required.']) rejects(() => privateDenial({ error: { code: '42501', message } }));
check(a.config.includes(`project_id = "mc-audit-cp4-${nonce}"`));
check(a.config.includes('stack = true') && a.config.includes('enabled = false'));
check(!/port\s*=|project_ref|functions\./.test(a.config));
for (const guard of ["current_user <> 'postgres'", "current_database() <> 'postgres'", "to_regclass('public.profiles')", "to_regnamespace('rehearsal_control')", "to_regnamespace('s4audit_private')", "to_regprocedure('auth.uid()')", "to_regprocedure('realtime.send(jsonb,text,text,boolean)')"]) check(a.sql.indexOf(guard) < a.sql.indexOf('create table'));
check(a.sql.startsWith('-- NEW disposable') && a.sql.trimEnd().endsWith('commit;'));
check(!/create (or replace )?function (auth\.uid|realtime\.send)/i.test(a.sql));
check(!/create role|create schema auth|set_config\('request.jwt|admin_set_(patient|doctor|staff)_account_status/i.test(a.sql));
check(a.sql.includes("status in ('success', 'failure', 'rejected', 'reported')"));
const source = fs.readFileSync(path.join(root, 'docs/rehearsal/admin-audit-production/migration.sql'), 'utf8').replaceAll('\r\n', '\n');
check(source.includes(a.writers));
check(a.sql.includes(a.writers) && a.sql.includes(a.broadcast));
check(a.sql.includes("realtime.messages.extension = 'broadcast'") && a.sql.includes("'admin:audit-logs'"));
check(!/on realtime.messages\s+for (insert|all)/i.test(a.sql));
check(a.sql.includes('grant select on public.audit_logs to authenticated'));
check(a.sql.includes('revoke all on public.audit_logs from public,anon,authenticated,service_role'));
const helper = fs.readFileSync(path.join(root, 'scripts/admin-audit-cp4.mjs'), 'utf8');
for (const required of ["'verify-started'", "flag: 'wx'", 'Malformed JWT rejected', 'RLS empty result', 'Business', 'p_status:', 'Actual INSERT invalidation', 'Real refreshed JWT', "['patient_management', 'register'], ['appointment_management', 'create'], ['visit_records', 'complete'], ['system_settings', 'settings_update']"]) {
  // Business rejection text is deliberately sourced from the passed SQL, not restated in the helper.
  check(required === 'Business' ? a.writers.includes('Business success events') : helper.includes(required));
}
const v = viewerSource('http://127.0.0.1:22000', 'offline-anon-placeholder', nonce);
check(v.client.includes(`storageKey:'cp4-${nonce}'`) && !v.client.includes('SERVICE_KEY'));
check(v.entry.includes('AdminAuthProvider') && v.entry.includes('src/pages/admin/AdminAuditLogs.jsx'));
check(!/App\.jsx|VITE_SUPABASE|send-patient|appointmentSms/.test(v.entry + v.client));
// Compose preparation uses no Docker/network. All credentials generated here are synthetic.
const packet = composeFiles(nonce, a.sql), config = JSON.parse(packet.files['compose.json']);
check(Object.keys(config.services).sort().join(',') === 'auth,db,kong,realtime,rest');
check(config.networks.isolated.internal === true && !config.networks.isolated.external);
check(config.volumes.database.name.startsWith('mc-audit-cp4-compose-') && !config.volumes.database.external);
check(config.services.kong.ports.length === 1 && config.services.kong.ports[0].host_ip === '127.0.0.1');
check(Object.entries(config.services).every(([name,s]) => s.pull_policy === 'never' && s.restart === 'no' && (name === 'kong' || !s.ports)));
check(config.services.realtime.environment.DB_HOST === 'db' && config.services.realtime.depends_on.db.condition === 'service_healthy');
check(config.services.realtime.networks.isolated.aliases.includes('realtime-dev'));
check(config.services.rest.healthcheck.test.includes('--ready') && config.services.kong.environment.KONG_ADMIN_LISTEN === 'off');
check(config.services.auth.environment.GOTRUE_DISABLE_SIGNUP === 'true' && config.services.auth.environment.GOTRUE_EXTERNAL_PHONE_ENABLED === 'false');
check(packet.manifest.existingVolumeReuse === false && packet.manifest.launchApproved === false);
check(digest(packet.files['db-start.sh']) === startupHash && packet.files['setup.sql'] === a.sql);
check(fs.readFileSync(path.join(assetDir,'compose.json'),'utf8') === JSON.stringify(composeDefinition('__CP4_NONCE__'),null,2)+'\n');
const manifestTemplate = fs.readFileSync(path.join(assetDir,'runtime-manifest.json'),'utf8');
check(manifestTemplate === (JSON.stringify(packet.manifest,null,2)+'\n').replaceAll(nonce,'__CP4_NONCE__'));
const sealed = { version:2,runtime:'docker-compose',syntheticOnly:true,nonce,files:Object.fromEntries(Object.entries(packet.files).map(([n,s])=>[n,digest(s)])) };
check(validateComposeFiles(sealed,n=>packet.files[n]).project === config.name);
rejects(()=>validateComposeFiles({...sealed,nonce:'../other'},n=>packet.files[n]));
rejects(()=>validateComposeFiles({...sealed,files:{...sealed.files,'../other':'bad'}},n=>packet.files[n]));
rejects(()=>validateComposeFiles(sealed,n=>n==='private/auth.env'?packet.files[n]+'changed':packet.files[n]));
const resealed = structuredClone(sealed), opened = structuredClone(config);
opened.services.kong.ports[0].host_ip='0.0.0.0';const broad=JSON.stringify(opened);resealed.files['compose.json']=digest(broad);
rejects(()=>validateComposeFiles(resealed,n=>n==='compose.json'?broad:packet.files[n]));
const env = name => Object.fromEntries(packet.files[`private/${name}.env`].trim().split('\n').map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
const authEnv=env('auth'),restEnv=env('rest'),realtimeEnv=env('realtime'),dbEnv=env('db');
checks += assertCp4KeyContracts(packet.files);
check(realtimeEnv.API_JWT_JWKS === restEnv.PGRST_JWT_SECRET && realtimeEnv.API_JWT_SECRET === dbEnv.JWT_SECRET);
check(authEnv.GOTRUE_DB_DATABASE_URL.includes('@db:5432/postgres') && restEnv.PGRST_DB_URI.includes('@db:5432/postgres'));
check(!Object.values(packet.files).some(s=>s.includes('supabase_db_mc-audit-cp4-strict')));
const gateway=JSON.parse(packet.files['private/kong.json']);
check(gateway.services.length === 4 && gateway.services.every(s=>s.plugins.some(p=>p.name==='key-auth')));
check(gateway.services.every(s=>s.plugins.find(p=>p.name==='request-transformer').config.add.headers.length===1 && !s.plugins.find(p=>p.name==='request-transformer').config.replace));
check(gateway.services.find(s=>s.name==='realtime-ws').url === 'http://realtime-dev:4000/socket');
for(const consumer of gateway.consumers){const [head,body,signature]=consumer.keyauth_credentials[0].key.split('.');check(crypto.createHmac('sha256',dbEnv.JWT_SECRET).update(head+'.'+body).digest('base64url')===signature);}
const workspace=path.join(os.tmpdir(),`mc-audit-cp4-compose-${nonce}`);
checks += assertCp4NetworkContracts(packet, workspace);
// Exercise exclusive preparation and disk/hash verification in a NEW temporary package only.
const scratchNonce=crypto.randomBytes(16).toString('hex'),scratch=prepareCompose(scratchNonce);
check(loadPlan(scratch).manifest.nonce===scratchNonce);
rejects(()=>prepareCompose(scratchNonce));
const scratchFile=path.join(scratch,'private/rest.env'),original=fs.readFileSync(scratchFile,'utf8');
fs.writeFileSync(scratchFile,original+'# offline tamper check\n');rejects(()=>loadPlan(scratch));fs.writeFileSync(scratchFile,original);
check(loadPlan(scratch).runtime==='docker-compose');
// Compile actual page + Auth/hooks against the isolated client, without executing that client.
const result = await build({ root, configFile: false, envFile: false, logLevel: 'error', plugins: [{ name: 'cp4-offline-compile', enforce: 'pre',
  resolveId(id) {
    if (id.endsWith('cp4-entry.jsx')) return '\0cp4-entry.jsx';
    if (id === 'cp4-client' || /\/supabaseClient(?:\.js)?$/.test(id)) return '\0cp4-client';
  }, load(id) { if (id === '\0cp4-entry.jsx') return v.entry; if (id === '\0cp4-client') return v.client; }
}, react()], css: { postcss: { plugins: [] } }, build: { write: false, minify: false, lib: { entry: 'cp4-entry.jsx', formats: ['es'] } } });
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
check(outputs.some(item => item.type === 'chunk' && item.code.includes('Synthetic viewer test.')));
console.log(`PASS ${checks} CP4 offline assertions; 0 failures; actual viewer harness compiled in memory. No network/SQL/Docker executed.`);
