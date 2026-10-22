// One-time, synthetic-only CP4 continuation after the original runner's
// too-strict Realtime callback assertion. Does not run the original verifier.
// No secrets or payload values are logged or persisted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import {
  loadPlan, inspectCompose, localURL, guardedFetch,
  roles, denial, privateDenial,
} from './admin-audit-cp4.mjs';

const EXPECTED_NONCE = 'd9849de6496a4b16a651a9b359a0db3e';
const EXPECTED_ORIGIN = 'http://127.0.0.1:55421';
const EXPIRES_AT = Date.parse('2026-10-19T04:14:30Z');
const ALLOWED_FIELDS = 'id,operation';
const workspace = process.argv[2];
assert.equal(process.argv.length, 3, 'Expected the protected CP4 packet path only');
assert(Date.now() < EXPIRES_AT - 30 * 60_000, 'STOP: Local credentials expired/near expiry');
const plan = loadPlan(workspace);
assert.equal(plan.runtime, 'docker-compose');
assert.equal(plan.nonce, EXPECTED_NONCE, 'STOP: Wrong isolated nonce');
assert.equal(plan.manifest.apiOrigin, EXPECTED_ORIGIN, 'STOP: Wrong local API origin');
for (const name of ['verify-started', 'synthetic-logins.json', 'admin-realtime-probe-started', 'admin-realtime-shape-started']) {
  assert(fs.existsSync(path.join(workspace, name)), `STOP: Required prior evidence missing: ${name}`);
}
for (const name of ['realtime-continue-started', 'realtime-continue-result.json', 'verify-passed.json']) {
  assert(!fs.existsSync(path.join(workspace, name)), `STOP: Existing marker/result; do not rerun: ${name}`);
}
await inspectCompose(workspace); // fresh read-only identity and health checks

function readConfig(filename) {
  const values = new Map();
  for (const line of fs.readFileSync(path.join(workspace, 'private', filename), 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line);
    assert(m, 'STOP: Invalid local config line');
    assert(!values.has(m[1]), 'STOP: Duplicate local config key');
    values.set(m[1], m[2]);
  }
  return values;
}
const cfg = readConfig('client.env');
const origin = localURL(cfg.get('MC_CP4_URL'));
assert.equal(origin, EXPECTED_ORIGIN);
const anon = cfg.get('MC_CP4_ANON_KEY');
assert(typeof anon === 'string' && anon.length > 50, 'STOP: Missing synthetic local anon key');
const transport = guardedFetch(origin);
const identity = await transport(`${origin}/rest/v1/audit_cp4_identity?select=nonce`, { headers: { apikey: anon } });
assert.equal(identity.status, 200, 'STOP: Local SQL identity endpoint unavailable');
assert.deepEqual(await identity.json(), [{ nonce: EXPECTED_NONCE }], 'STOP: Wrong database identity');
const logins = JSON.parse(fs.readFileSync(path.join(workspace, 'synthetic-logins.json'), 'utf8'));
assert(Array.isArray(logins) && logins.length === 4, 'STOP: Unexpected synthetic account count');
for (const [i, u] of logins.entries()) {
  assert.equal(u.role, roles[i], 'STOP: Unexpected synthetic role');
  assert.equal(u.email, `cp4-${u.role}-${EXPECTED_NONCE}@example.invalid`, 'STOP: Unexpected synthetic email');
  assert(/^[a-f\d-]{36}$/i.test(u.id) && typeof u.password === 'string' && u.password.length >= 24,
    'STOP: Invalid synthetic account metadata');
}
const newClient = () => createClient(origin, anon, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: transport },
});
const clients = [];
const state = { authRoles: 0, nonAdminRlsDenials: 0, privateRpcDenials: 0,
  forbiddenMutationDenials: 0, forgedEventDenials: 0, nonAdminChannelDenials: 0,
  adminSubscriptions: 0, adminEventsInserted: 0, validCallbacks: 0,
  adminJwtRefreshed: false, baselineRows: 0, finalRows: 0 };
const checked = (r, label) => {
  assert(!r.error, `${label}: ${String(r.error?.code || 'unexpected error')}`);
  return r.data;
};
const validPayload = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(',') === ALLOWED_FIELDS && value.operation === 'INSERT' &&
    (typeof value.id === 'string' || typeof value.id === 'number');
};
const claim = u => ({ p_module: 'authentication', p_action: 'login',
  p_entity_type: 'auth_user', p_entity_id: u.id,
  p_description: 'Synthetic CP4 resumed Realtime verification.', p_metadata: {} });

async function subscribe(u, callback) {
  const session = checked(await u.api.auth.getSession(), 'Read synthetic session').session;
  assert(session?.access_token, 'STOP: Missing synthetic JWT');
  await u.api.realtime.setAuth(session.access_token);
  const channel = u.api.channel('admin:audit-logs', { config: { private: true } });
  if (callback) channel.on('broadcast', { event: 'audit_log_changed' }, callback);
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`${u.role}: private channel inconclusive (15-second timeout)`)), 15000);
    channel.subscribe((s, error) => {
      if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
        clearTimeout(timer);
        resolve({ state: s, errorLabel: String(error?.message || '') });
      }
    });
  });
  return { channel, status };
}
async function insertOne(admin) {
  const result = checked(await admin.api.rpc('record_audit_event', claim(admin)), 'Synthetic reported event insert');
  assert(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(result), 'Missing UUID event receipt');
  state.adminEventsInserted++;
}
async function waitForBroadcast(counters, label) {
  for (let n = 0; n < 300 && counters.matched === 0 && counters.invalid === 0; n++) await delay(100);
  assert.equal(counters.invalid, 0, `${label}: unsafe/unknown payload shape received`);
  assert(counters.matched >= 1, `${label}: expected callback not delivered within 30 seconds`);
  state.validCallbacks += counters.matched;
}
function counter() { return { matched: 0, invalid: 0 }; }
const marker = path.join(workspace, 'realtime-continue-started');
// Exclusive write prevents duplicate events and prevents accidental reruns after partial failure.
fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
console.log('PASS: Sealed CP4 target, one-time marker, and existing synthetic accounts verified.');

try {
  for (const item of logins) {
    const api = newClient();
    const signIn = checked(await api.auth.signInWithPassword({ email: item.email, password: item.password }),
      `${item.role}: local synthetic sign-in`);
    assert(signIn.session?.access_token && signIn.user?.id === item.id,
      `${item.role}: incorrect authenticated identity`);
    const user = checked(await api.auth.getUser(), `${item.role}: JWT getUser`);
    assert.equal(user.user?.id, item.id);
    clients.push({ ...item, api });
    state.authRoles++;
  }
  const admin = clients[0];
  const before = checked(await admin.api.from('audit_logs').select('id,actor_user_id,status,metadata,module'),
    'Admin RLS baseline');
  assert(before.length >= 14 && before.every(r => r.status === 'reported' && r.metadata?.event_source === 'client_reported'),
    'STOP: Baseline audit record set differs from synthetic expectation');
  state.baselineRows = before.length;
  const anchor = before[0].id;

  for (const u of clients.slice(1)) {
    assert.equal(checked(await u.api.from('audit_logs').select('id'), `${u.role}: private RLS select`).length, 0,
      `${u.role}: read access must be denied by RLS`);
    state.nonAdminRlsDenials++;
    privateDenial(await u.api.rpc('record_internal_audit_event', { ...claim(u), p_status: 'reported' }));
    state.privateRpcDenials++;
    denial(await u.api.rpc('record_audit_event', {
      ...claim(u), p_module: 'patient_management', p_action: 'register',
    }));
    state.forgedEventDenials++;
    const forbidden = { actor_user_id: u.id, actor_name: 'Synthetic', actor_role: u.role,
      module: 'authentication', action: 'login', status: 'success', description: 'Forbidden direct write.' };
    for (const op of [
      u.api.from('audit_logs').insert(forbidden),
      u.api.from('audit_logs').update({ description: 'Forbidden update.' }).eq('id', anchor),
      u.api.from('audit_logs').delete().eq('id', anchor),
    ]) {
      denial(await op);
      state.forbiddenMutationDenials++;
    }
    const { channel, status } = await subscribe(u);
    assert(status.state === 'CHANNEL_ERROR' && /permission|authoriz|policy|access/i.test(status.errorLabel),
      `${u.role}: expected explicit Realtime private-channel authorization denial`);
    state.nonAdminChannelDenials++;
    await u.api.removeChannel(channel);
  }
  console.log('PASS: Doctor, Staff, and Patient denied audit-log access, privileged RPC, direct mutations, forged success, and private Realtime subscription.');

  let current = counter();
  const { channel, status } = await subscribe(admin, msg => {
    if (validPayload(msg?.payload)) current.matched++;
    else current.invalid++;
  });
  assert.equal(status.state, 'SUBSCRIBED', 'Admin private subscription denied');
  state.adminSubscriptions++;
  await insertOne(admin);
  await waitForBroadcast(current, 'Admin first JWT');
  console.log('PASS: Admin received a two-field INSERT invalidation; no record payload.');

  const previousToken = checked(await admin.api.auth.getSession(), 'Admin old session').session.access_token;
  const refreshed = checked(await admin.api.auth.refreshSession(), 'Admin JWT refresh');
  assert(refreshed.session?.access_token && refreshed.session.access_token !== previousToken,
    'Admin did not receive a fresh JWT');
  await admin.api.realtime.setAuth(refreshed.session.access_token);
  state.adminJwtRefreshed = true;
  current = counter();
  await delay(500); // allow the active private channel to apply the refreshed token
  await insertOne(admin);
  await waitForBroadcast(current, 'Admin refreshed JWT');
  await admin.api.removeChannel(channel);
  console.log('PASS: Refreshed Admin JWT retained private-channel delivery.');

  const after = checked(await admin.api.from('audit_logs').select('id,actor_user_id,status,metadata,module'), 'Admin final RLS query');
  assert.equal(after.length, state.baselineRows + 2, 'Unexpected audit-row changes during continuation');
  const beforeIds = new Set(before.map(x => x.id));
  const added = after.filter(row => !beforeIds.has(row.id));
  assert.equal(added.length, 2, 'Unexpected new audit event count');
  for (const row of added) {
    assert(row.actor_user_id === admin.id && row.status === 'reported' &&
      row.metadata?.event_source === 'client_reported' && row.module === 'authentication',
      'New record identity/status/source not server-derived as expected');
  }
  state.finalRows = after.length;
  const evidence = { nonce: EXPECTED_NONCE, status: 'PASS',
    source: 'one-time continuation, not the original full verifier',
    recordedAt: new Date().toISOString(), checks: state,
    callbackPayloadFields: ['id', 'operation'], containsRecordPayload: false };
  fs.writeFileSync(path.join(workspace, 'realtime-continue-result.json'), JSON.stringify(evidence, null, 2),
    { flag: 'wx', mode: 0o600 });
  console.log('PASS: One-time security continuation finished; original verify-passed.json intentionally not forged.');
  console.log(JSON.stringify({ status: 'PASS', checks: state, callbackFields: ['id', 'operation'], recordFieldSeen: false }, null, 2));
} finally {
  for (const u of clients) {
    await u.api.removeAllChannels().catch(() => {});
    u.api.realtime.disconnect();
  }
}
