// One-time, synthetic-only Admin Realtime delivery probe for the October 2026 CP4 Docker stack.
// No new accounts, production access, schema changes, Docker changes or repo edits.
// Writes ONE synthetic client-reported audit event to the sealed, local CP4 instance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadPlan, inspectCompose, localURL, guardedFetch } from './admin-audit-cp4.mjs';

const NONCE = 'd9849de6496a4b16a651a9b359a0db3e';
const ORIGIN = 'http://127.0.0.1:55421';
const workspace = process.argv[2];
let client;
let stage = 'preflight';
let markerWritten = false;
const summary = {
  target: 'isolated CP4', nonce: NONCE, stage,
  subscription: 'not_attempted',
  exactCallbacks: 0, anyBroadcastCallbacks: 0,
  exactPayloadShapeMatches: 0, shapeMismatchCallbacks: 0,
  recordFieldSeen: false, auditRecordInserted: false,
  adminDelivery: 'not_tested',
};

function requireSecretValue(map, key) {
  const value = map.get(key);
  assert(typeof value === 'string' && value.length > 0, `Missing local test setting ${key}`);
  return value;
}
function readCredentials(filename) {
  const env = new Map();
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    assert(!env.has(m[1]), 'Duplicate local test environment key');
    env.set(m[1], m[2]);
  }
  return env;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.equal(process.argv.length, 3, 'Pass only the sealed CP4 workspace path');
  assert(workspace && fs.existsSync(workspace), 'CP4 workspace missing');
  const plan = loadPlan(workspace);
  assert.equal(plan.runtime, 'docker-compose');
  assert.equal(plan.nonce, NONCE, 'Unexpected CP4 nonce');
  assert.equal(plan.manifest.apiOrigin, ORIGIN, 'Unexpected sealed API origin');
  assert(fs.existsSync(path.join(workspace, 'verify-started')), 'Original run-start marker missing');
  assert(!fs.existsSync(path.join(workspace, 'verify-passed.json')), 'Original runner already passed; no probe necessary');
  assert(!fs.existsSync(path.join(workspace, 'admin-realtime-probe-started')), 'Probe already started; never rerun');
  assert(!fs.existsSync(path.join(workspace, 'admin-realtime-probe-result.json')), 'Existing probe result found; preserve it');
  await inspectCompose(workspace); // read-only Docker verification, new inspection artifact only

  const env = readCredentials(path.join(workspace, 'private', 'client.env'));
  const origin = localURL(requireSecretValue(env, 'MC_CP4_URL'));
  assert.equal(origin, ORIGIN, 'Nonlocal API origin forbidden');
  const anonKey = requireSecretValue(env, 'MC_CP4_ANON_KEY');
  const syntheticUsers = JSON.parse(fs.readFileSync(path.join(workspace, 'synthetic-logins.json'), 'utf8'));
  assert(Array.isArray(syntheticUsers) && syntheticUsers.length === 4, 'Expected four existing synthetic accounts');
  for (const role of ['admin', 'doctor', 'staff', 'patient']) {
    const u = syntheticUsers.find(x => x.role === role);
    assert(u && u.email === `cp4-${role}-${NONCE}@example.invalid`, 'Synthetic user identity mismatch');
  }
  const admin = syntheticUsers.find(x => x.role === 'admin');
  assert(typeof admin.password === 'string' && admin.password.length >= 20, 'Missing existing synthetic Admin password');
  const transport = guardedFetch(origin);
  const markerResponse = await transport(`${origin}/rest/v1/audit_cp4_identity?select=nonce`, {
    headers: { apikey: anonKey },
  });
  assert.equal(markerResponse.status, 200, 'Local CP4 marker unavailable');
  assert.deepEqual(await markerResponse.json(), [{ nonce: NONCE }], 'SQL identity mismatch');

  fs.writeFileSync(path.join(workspace, 'admin-realtime-probe-started'), new Date().toISOString(), { flag: 'wx' });
  markerWritten = true;
  console.log('PASS: Exact isolated CP4 target, existing synthetic accounts, and one-time probe guard.');

  client = createClient(origin, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: transport },
  });
  stage = 'sign_in';
  const signedIn = await client.auth.signInWithPassword({ email: admin.email, password: admin.password });
  assert(!signedIn.error && signedIn.data.session?.access_token && signedIn.data.user?.id === admin.id,
    'Existing synthetic Admin sign-in failed');
  await client.realtime.setAuth(signedIn.data.session.access_token);

  stage = 'subscription';
  let receivedResolve;
  const receivedPromise = new Promise(resolve => { receivedResolve = resolve; });
  const channel = client.channel('admin:audit-logs', { config: { private: true } });
  channel.on('broadcast', { event: '*' }, () => { summary.anyBroadcastCallbacks += 1; });
  channel.on('broadcast', { event: 'audit_log_changed' }, message => {
    summary.exactCallbacks += 1;
    const payload = message?.payload;
    const keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [];
    const matches = payload?.operation === 'INSERT' && keys.length === 1;
    if (keys.includes('record')) summary.recordFieldSeen = true;
    if (matches) {
      summary.exactPayloadShapeMatches += 1;
      receivedResolve();
    } else summary.shapeMismatchCallbacks += 1;
  });
  const state = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime subscription timeout')), 15000);
    channel.subscribe((status) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        clearTimeout(timer);
        resolve(status);
      }
    });
  });
  summary.subscription = state;
  assert.equal(state, 'SUBSCRIBED', 'Synthetic Admin could not subscribe to the private channel');
  console.log('PASS: Existing synthetic Admin authenticated and subscribed.');

  stage = 'single_synthetic_event';
  const write = await client.rpc('record_audit_event', {
    p_module: 'authentication', p_action: 'login', p_entity_type: 'auth_user',
    p_entity_id: admin.id, p_description: 'Synthetic one-time CP4 broadcast probe.', p_metadata: {},
  });
  assert(!write.error && /^[a-f0-9-]{36}$/i.test(String(write.data)), 'Synthetic audit RPC failed');
  summary.auditRecordInserted = true;
  console.log('PASS: One additional synthetic client-reported event inserted; awaiting Realtime delivery (up to 30s).');

  stage = 'waiting_for_callback';
  let timeout;
  try {
    await Promise.race([
      receivedPromise,
      new Promise(resolve => { timeout = setTimeout(resolve, 30000); }),
    ]);
  } finally { clearTimeout(timeout); }
  // Allow queued callbacks to settle before reporting counts.
  await pause(250);
  if (summary.exactPayloadShapeMatches > 0) {
    summary.adminDelivery = 'PASS';
    console.log('PASS: Existing Admin received the minimal INSERT invalidation.');
  } else if (summary.exactCallbacks > 0) {
    summary.adminDelivery = 'SHAPE_MISMATCH';
    console.log('INCONCLUSIVE: Admin received an event but it did not match the expected minimal payload.');
  } else if (summary.anyBroadcastCallbacks > 0) {
    summary.adminDelivery = 'DIFFERENT_EVENT';
    console.log('INCONCLUSIVE: Admin received a broadcast, but not the expected event name.');
  } else {
    summary.adminDelivery = 'NO_CALLBACK';
    console.log('INCONCLUSIVE: No Admin broadcast callback arrived within 30 seconds.');
  }
}

try {
  await main();
} catch (error) {
  summary.adminDelivery = 'ERROR';
  console.error(`STOP: Probe stage '${stage}' failed. No credentials printed.`);
  process.exitCode = 1;
} finally {
  summary.stage = stage;
  if (client) {
    try { await client.removeAllChannels(); client.realtime.disconnect(); } catch { /* no secret-bearing error output */ }
  }
  if (markerWritten) {
    try {
      fs.writeFileSync(path.join(workspace, 'admin-realtime-probe-result.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
      console.log('PASS: Non-secret probe evidence saved in the protected CP4 workspace.');
    } catch {
      console.error('WARNING: Probe evidence could not be saved; preserve workspace.');
      process.exitCode = 1;
    }
  }
  if (markerWritten) {
    console.log(JSON.stringify({ subscription: summary.subscription,
      auditRecordInserted: summary.auditRecordInserted, adminDelivery: summary.adminDelivery,
      exactCallbacks: summary.exactCallbacks, anyBroadcastCallbacks: summary.anyBroadcastCallbacks,
      exactPayloadShapeMatches: summary.exactPayloadShapeMatches,
      shapeMismatchCallbacks: summary.shapeMismatchCallbacks,
      recordFieldSeen: summary.recordFieldSeen }, null, 2));
  }
}
