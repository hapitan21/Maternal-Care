// CP4 diagnostic only: one synthetic event, no new accounts, schema changes, or production access.
// IMPORTANT: place in the project's scripts/ directory (imports are relative to this script).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadPlan, inspectCompose, localURL, guardedFetch } from './admin-audit-cp4.mjs';

const nonce = 'd9849de6496a4b16a651a9b359a0db3e';
const origin = 'http://127.0.0.1:55421';
const workspace = process.argv[2];
const startMarker = 'admin-realtime-shape-started';
const resultFile = 'admin-realtime-shape-result.json';
let client;
let marked = false;
let stage = 'preflight';
const result = { stage, subscription: 'NOT_ATTEMPTED', eventInserted: false,
  expectedEventCallbacks: 0, payloadShape: null, recordFieldSeen: false };

const keys = obj => obj && typeof obj === 'object' && !Array.isArray(obj)
  ? Object.keys(obj).slice(0, 20).map(s => s.slice(0, 48).replace(/[^A-Za-z0-9_-]/g, '?')).sort() : [];
const category = value => value === 'INSERT' ? 'INSERT' : value === undefined ? 'ABSENT'
  : value === null ? 'NULL' : typeof value === 'string' ? 'OTHER_STRING' : typeof value;
const parseEnv = file => {
  const entries = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    assert(!entries.has(m[1]), 'Duplicate local credentials setting');
    entries.set(m[1], m[2]);
  }
  return entries;
};
const nonempty = (map, name) => {
  const value = map.get(name);
  assert(typeof value === 'string' && value.length > 0, `Missing local setting ${name}`);
  return value;
};

async function run() {
  assert.equal(process.argv.length, 3, 'Provide only sealed CP4 workspace path');
  assert(workspace && fs.existsSync(workspace), 'Sealed workspace missing');
  const plan = loadPlan(workspace);
  assert.equal(plan.runtime, 'docker-compose');
  assert.equal(plan.nonce, nonce, 'Wrong isolated project');
  assert.equal(plan.manifest.apiOrigin, origin, 'Wrong local API origin');
  assert(fs.existsSync(path.join(workspace, 'verify-started')), 'First-run evidence missing');
  assert(fs.existsSync(path.join(workspace, 'admin-realtime-probe-result.json')), 'Initial probe evidence missing');
  assert(!fs.existsSync(path.join(workspace, 'verify-passed.json')), 'Original test suite already passed');
  assert(!fs.existsSync(path.join(workspace, startMarker)), 'Shape probe already attempted; do not retry');
  assert(!fs.existsSync(path.join(workspace, resultFile)), 'Prior shape evidence exists');
  await inspectCompose(workspace); // local read-only runtime validation
  const env = parseEnv(path.join(workspace, 'private', 'client.env'));
  assert.equal(localURL(nonempty(env, 'MC_CP4_URL')), origin, 'Nonlocal destination forbidden');
  const anon = nonempty(env, 'MC_CP4_ANON_KEY');
  const users = JSON.parse(fs.readFileSync(path.join(workspace, 'synthetic-logins.json'), 'utf8'));
  assert(Array.isArray(users) && users.length === 4, 'Expected existing synthetic users');
  const admin = users.find(u => u.role === 'admin');
  assert(admin?.email === `cp4-admin-${nonce}@example.invalid` && typeof admin.password === 'string'
    && admin.password.length >= 20, 'Existing synthetic Admin missing');
  const transport = guardedFetch(origin);
  const marker = await transport(`${origin}/rest/v1/audit_cp4_identity?select=nonce`, { headers: { apikey: anon } });
  assert.equal(marker.status, 200, 'Local CP4 marker request failed');
  assert.deepEqual(await marker.json(), [{ nonce }], 'Unexpected database identity');

  fs.writeFileSync(path.join(workspace, startMarker), new Date().toISOString(), { flag: 'wx' });
  marked = true;
  console.log('PASS: Exact isolated CP4 and one-time shape probe validated.');
  client = createClient(origin, anon, { auth: { persistSession: false, autoRefreshToken: false,
    detectSessionInUrl: false }, global: { fetch: transport } });
  stage = 'sign_in';
  const signedIn = await client.auth.signInWithPassword({ email: admin.email, password: admin.password });
  assert(!signedIn.error && signedIn.data.user?.id === admin.id && signedIn.data.session?.access_token,
    'Existing synthetic Admin authentication failed');
  await client.realtime.setAuth(signedIn.data.session.access_token);

  stage = 'subscription';
  let onMessage;
  const firstMessage = new Promise(resolve => { onMessage = resolve; });
  const channel = client.channel('admin:audit-logs', { config: { private: true } });
  channel.on('broadcast', { event: 'audit_log_changed' }, message => {
    result.expectedEventCallbacks += 1;
    if (result.payloadShape) return;
    const outer = message?.payload;
    const nested = outer?.payload;
    result.recordFieldSeen = !!(outer && typeof outer === 'object' && 'record' in outer)
      || !!(nested && typeof nested === 'object' && 'record' in nested);
    result.payloadShape = {
      callbackFields: keys(message), payloadFields: keys(outer), nestedPayloadFields: keys(nested),
      directOperation: category(outer?.operation), nestedOperation: category(nested?.operation),
      topLevelOperation: category(message?.operation),
    };
    onMessage();
  });
  const state = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Subscription timeout')), 15000);
    channel.subscribe(status => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        clearTimeout(timeout); resolve(status);
      }
    });
  });
  result.subscription = state;
  assert.equal(state, 'SUBSCRIBED', 'Admin private-channel subscription failed');
  console.log('PASS: Existing synthetic Admin subscribed.');

  stage = 'one_event';
  const write = await client.rpc('record_audit_event', {
    p_module: 'authentication', p_action: 'login', p_entity_type: 'auth_user',
    p_entity_id: admin.id, p_description: 'Synthetic CP4 callback shape validation.', p_metadata: {},
  });
  assert(!write.error && /^[a-f0-9-]{36}$/i.test(String(write.data)), 'Synthetic-only audit write failed');
  result.eventInserted = true;
  console.log('PASS: One additional synthetic audit event inserted; checking callback shape.');
  stage = 'waiting_for_event';
  let timeout;
  try {
    await Promise.race([firstMessage, new Promise(resolve => { timeout = setTimeout(resolve, 30000); })]);
  } finally { clearTimeout(timeout); }
  if (result.payloadShape) console.log('PASS: Admin callback shape captured without payload values.');
  else console.log('INCONCLUSIVE: No exact-event callback within 30 seconds.');
}

try {
  await run();
} catch {
  process.exitCode = 1;
  console.error(`STOP: Shape probe failed during ${stage}; no credentials or raw server errors displayed.`);
} finally {
  result.stage = stage;
  if (client) {
    try { await client.removeAllChannels(); client.realtime.disconnect(); } catch { /* no secret output */ }
  }
  if (marked) {
    try {
      fs.writeFileSync(path.join(workspace, resultFile), JSON.stringify(result, null, 2), { flag: 'wx' });
      console.log('PASS: Non-secret shape evidence preserved in isolated workspace.');
    } catch { process.exitCode = 1; console.error('STOP: Could not save protected shape evidence.'); }
    console.log(JSON.stringify({ subscription: result.subscription, eventInserted: result.eventInserted,
      expectedEventCallbacks: result.expectedEventCallbacks, payloadShape: result.payloadShape,
      recordFieldSeen: result.recordFieldSeen }, null, 2));
  }
}
