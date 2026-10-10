// Offline session/RPC/storage fixtures; no Supabase connection or mutations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'espree';
if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/lib/staffRequestPatientAvatars.js', root), 'utf8');
const profile = await readFile(new URL('src/lib/profilePicture.js', root), 'utf8');
const inactivity = await readFile(new URL('src/lib/roleInactivity.js', root), 'utf8');
function extract(text, names) {
  return parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true }).body.filter(node => {
    const item = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    return item && (names.includes(item.id?.name) || item.declarations?.some(entry => names.includes(entry.id.name)));
  }).map(node => text.slice(...node.range)).join('\n');
}
const context = vm.createContext({ URL, Map, Set, Promise, AbortController, Date, setTimeout, clearTimeout, atob });
const dependencies = {
  './profilePicture': new vm.SourceTextModule(extract(profile, ['profilePictureBucket', 'profilePictureUpdatedEvent', 'maximumProfilePictureBytes', 'allowedProfilePictureTypes', 'validateProfilePicture', 'createProfilePictureError']), { context }),
  './roleInactivity': new vm.SourceTextModule(extract(inactivity, ['getLogicalSessionIdentity']), { context }),
};
const module = new vm.SourceTextModule(source, { context });
await module.link(name => dependencies[name]); await module.evaluate();
const { getPatientAvatarStoragePath: path, createStaffRequestAvatarLoader: create, createStaffRequestAvatarCache: createCache } = module.namespace;
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
const origin = 'https://offline.example.test';
for (const value of ['linked-user/avatar', 'profile-pictures/linked-user/avatar', '/profile-pictures/linked-user/avatar', ...['public','authenticated','sign'].map(kind => `${origin}/storage/v1/object/${kind}/profile-pictures/linked-user/avatar?token=synthetic`)]) {
  check(path(value, origin) === 'linked-user/avatar', 'Resolve authoritative reference without query/token leakage');
}
for (const value of ['', null, 'data:image/png;base64,AAAA', 'blob:other', 'https://other.test/storage/v1/object/public/profile-pictures/u/avatar', `${origin}/storage/v1/object/public/other/u/avatar`, `${origin}/storage/v1/object/public/profile-pictures/%2e%2e%2fu/avatar`, 'a/../avatar', 'a//avatar', 'a/avatar?token=private', 'javascript:bad', 'a\\avatar']) {
  check(path(value, origin) === '', 'Unsafe/unrelated reference falls back: ' + value);
}
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(options = {}) {
  let callback;
  const state = { session: session('staff-a','one'), references: { a: 'linked-a/avatar', b: '' }, rpc: [], downloads: [], revoked: [], created: [], snapshots: [], rpcError: false, downloadError: false, invalidImage: false, unsubscribed: false };
  if ('initialSession' in options) state.session = options.initialSession;
  const client = {
    supabaseUrl: origin,
    auth: { onAuthStateChange(fn) { callback = fn; return { data: { subscription: { unsubscribe() { state.unsubscribed = true; } } } }; }, getSession: async () => ({ data: { session: state.session }, error: options.authError ? {message:'Synthetic auth lookup failure'} : null }) },
    rpc(name, args) {
      state.rpc.push([name, args]);
      if (state.rpcGate) { const pending = state.rpcGate; state.rpcGate = null; return pending.promise; }
      if (state.throwRpc) return Promise.reject(new Error('Synthetic network failure'));
      return Promise.resolve({ data: args.p_patient_ids.map(id => ({ patient_id: id, avatar_url: state.references[id] })), error: state.rpcError ? (typeof state.rpcError === 'object' ? state.rpcError : { message: 'denied' }) : null });
    },
    storage: { from(bucket) { return { async download(path, options, parameters) {
      state.downloads.push({ bucket, path, options, parameters });
      if (state.downloadGate) { const pending = state.downloadGate; state.downloadGate = null; return pending.promise; }
      return { data: { type: state.invalidImage ? 'text/html' : 'image/png', size: state.size || 40, version: state.downloads.length }, error: state.downloadError ? { message: 'denied' } : null };
    } }; } },
  };
  const parameters = { ...options.loaderOptions, client, userId: 'staff-a', onChange: value => state.snapshots.push(value),
    createObjectUrl(blob) { const url = 'blob:offline-' + blob.version; state.created.push(url); return url; }, revokeObjectUrl(url) { state.revoked.push(url); } };
  const loader = options.cache ? null : create(parameters);
  const cache = options.cache ? createCache(parameters) : null;
  state.emit = value => { state.session = value; callback(value ? 'SIGNED_IN' : 'SIGNED_OUT', value); };
  return { loader, cache, state, photo: id => (cache ? cache.getSnapshot('staff-a') : state.snapshots.at(-1))?.photos.get(id) || '' };
}
function session(user, logical) { return { user: { id: user }, access_token: 'x.' + Buffer.from(JSON.stringify({ session_id: logical })).toString('base64') + '.x' }; }
for (const options of [{initialSession:null},{authError:true}]) {
  const {loader,state} = fixture(options); loader.setPatientIds(['a']); await tick();
  check(state.snapshots.at(-1)?.identity === '', 'Unavailable initial auth resolves pending state to safe initials');
  check(state.rpc.length === 0, 'Unavailable initial auth never requests patient photos'); loader.dispose();
}
{
  const { loader, state, photo } = fixture(); loader.setPatientIds(['a','a','b']); await tick(); await loader.refresh(false);
  check(state.rpc.length === 1 && state.rpc[0][0] === 'get_patient_avatar_urls', 'One authorized batched RPC');
  check(JSON.stringify(state.rpc[0][1].p_patient_ids) === '["a","b"]', 'Dedupe linked patient IDs');
  check(photo('a').startsWith('blob:') && photo('b') === '', 'Verified photo plus missing-image fallback');
  check(state.downloads[0].bucket === 'profile-pictures' && state.downloads[0].path === 'linked-a/avatar', 'Existing bucket/path contract');
  check(state.downloads[0].parameters.cache === 'no-store' && !!state.downloads[0].options.cacheNonce, 'Bypass stale browser/CDN bytes');
  loader.setPatientIds(['a']); await loader.refresh(false);
  check(state.rpc.length === 1 && state.downloads.length === 1, 'List-to-View uses same verified photo without duplicate requests');
  const retained = photo('a'); loader.setPatientIds([]); await loader.refresh();
  check(photo('a') === retained && !state.revoked.includes(retained) && state.rpc.length === 1, 'All pauses reads and retains known photos');
  state.emit(session('staff-a','one')); loader.setPatientIds(['a']); await loader.refresh(false);
  check(photo('a') === retained && state.downloads.length === 1, 'Same logical auth refresh and Requests return reuse known bytes');
  const previous = photo('a'); await loader.refresh();
  check(photo('a') !== previous && state.revoked.includes(previous), 'Authoritative refresh replaces old bytes and releases URL');
  state.references.a = ''; await loader.refresh(); check(photo('a') === '', 'Removed profile photo clears image');
  state.references.a = 'linked-a/avatar'; state.downloadError = true; await loader.refresh(); check(photo('a') === '', 'Private storage denial safely retains initials');
  state.downloadError = false; state.invalidImage = true; await loader.refresh(); check(photo('a') === '', 'Non-image data never displayed');
  state.invalidImage = false; state.rpcError = true; await loader.refresh(); check(photo('a') === '', 'Returned RPC failure safe');
  state.rpcError = false; state.throwRpc = true; await loader.refresh(); check(photo('a') === '', 'Rejected RPC safe');
  state.throwRpc = false; await loader.refresh(); check(!!photo('a'), 'Appropriate refresh recovers');
  state.emit(session('staff-a','two')); check(photo('a') === '', 'Same-user new session immediately clears image'); await tick(); await loader.refresh(false);
  check(!!photo('a'), 'New session independently reloads');
  state.emit(session('staff-b','other')); check(photo('a') === '', 'Different account immediately clears image');
  const before = state.rpc.length; await loader.refresh(); check(state.rpc.length === before, 'Mismatched Staff identity sends no patient RPC');
  state.emit(null); check(photo('a') === '', 'Logout fallback'); loader.dispose(); check(state.unsubscribed, 'Auth listener cleaned up');
}
for (const boundary of ['rpc', 'download']) {
  for (const change of ['patient', 'session', 'logout', 'unmount']) {
    const { loader, state, photo } = fixture(); await tick();
    const pending = gate(); state[boundary + 'Gate'] = pending; loader.setPatientIds(['a']);
    await tick();
    if (change === 'patient') loader.setPatientIds(['b']);
    if (change === 'session') state.emit(session('staff-a', 'replacement'));
    if (change === 'logout') state.emit(null);
    if (change === 'unmount') loader.dispose();
    pending.resolve(boundary === 'rpc' ? { data: [{ patient_id: 'a', avatar_url: 'linked-a/avatar' }], error: null } : { data: { type: 'image/png', size: 10, version: 99 }, error: null });
    await tick(); await loader.refresh(false);
    if (change === 'patient') check(photo('b') === '', boundary + ': patient switch cannot display A as B');
    else if (change === 'session') check(photo('a') !== 'blob:offline-99', boundary + ': old-session response cannot replace new-session data');
    else check(photo('a') === '' && state.created.length === 0, boundary + ': late response after ' + change + ' discarded');
    loader.dispose(); check(state.created.every(url => state.revoked.includes(url)), boundary + ': all created blob URLs released after ' + change);
  }
}
{
  const { loader, state, photo } = fixture(); state.references.b = state.references.a;
  loader.setPatientIds(['a','b']); await tick(); await loader.refresh(false);
  check(state.downloads.length === 1 && photo('a') === photo('b'), 'Repeated authoritative storage reference downloads once per batch');
  state.references.b = 'linked-b/avatar'; await loader.refresh();
  check(photo('a') !== photo('b'), 'Distinct linked identities resolve distinct authoritative photos'); loader.dispose();
}
{
  const { loader, state } = fixture(); await tick(); const pending = gate(); state.rpcGate = pending; loader.setPatientIds(['a']); await tick();
  const first = loader.refresh(), second = loader.refresh(); check(first === second && state.rpc.length === 1, 'Overlapping refreshes coalesced');
  loader.setPatientIds(['b']); pending.resolve({ data: [{ patient_id: 'a', avatar_url: '' }], error: null }); await tick();
  check(state.rpc.length === 2 && state.rpc[1][1].p_patient_ids[0] === 'b', 'Patient change during request queues only missing linked patient'); loader.dispose();
}
check(!source.includes('getPublicUrl') && !source.includes('createSignedUrl') && !source.includes('.from("profiles")'), 'No public URL generation, bearer URLs or guessed profile query');
check(!/localStorage|sessionStorage|indexedDB/.test(source), 'Private bytes never enter persistent browser storage');
{
  const {cache,state,photo} = fixture({cache:true});
  let notifications = 0;
  let leave = cache.subscribe('staff-a',['a','b'],()=>notifications++);
  await tick(); const verified = photo('a');
  check(!!verified && notifications > 0, 'Shared cache loads authorized pictures');
  const reads = state.rpc.length, downloads = state.downloads.length;
  for (let cycle=0;cycle<6;cycle++) {
    leave();
    check(photo('a') === verified && !state.revoked.includes(verified), 'Route unmount keeps same-session bytes');
    state.emit(session('staff-a','one'));
    leave = cache.subscribe('staff-a',['a','b'],()=>notifications++);
    check(photo('a') === verified, 'Synchronous remount snapshot already contains verified photo');
    await tick();
  }
  check(state.rpc.length === reads && state.downloads.length === downloads, 'Repeated route remounts and auth object refresh need no image requests');
  check(!cache.getSnapshot('staff-b').photos.size, 'Other Staff account cannot read cached photos');
  const release = cache.retainUrls('staff-a',[verified]);
  state.references.a = 'linked-a/new-avatar';
  // A focus refresh publishes a new URL while the old one is still displayed.
  const duplicate = cache.subscribe('staff-a',['a'],()=>{});
  state.emit(session('staff-a','two'));
  check(state.revoked.includes(verified) && !photo('a'), 'Actual session replacement clears bytes even with a visible lease');
  await tick(); check(!!photo('a') && photo('a') !== verified, 'Replacement session loads independent photo');
  release(); duplicate(); leave();
  state.emit(null); check(!photo('a'), 'Logout on Dashboard clears cache without mounted Appointments');
  check(state.created.every(url=>state.revoked.includes(url)), 'Detached logout revokes every private blob');
  cache.dispose(); check(state.unsubscribed, 'Cache disposal removes auth subscription');
}
{
  const windowTarget = new EventTarget(), documentTarget = new EventTarget(); documentTarget.visibilityState = 'visible';
  const {cache,state,photo} = fixture({cache:true,loaderOptions:{windowTarget,documentTarget}});
  let leave = cache.subscribe('staff-a',['a'],()=>{}); await tick(); const verified = photo('a'); leave();
  state.references.a = '';
  windowTarget.dispatchEvent(new Event('profile-picture-updated')); await tick();
  check(state.rpc.length === 1 && photo('a') === verified, 'Photo update while on another Staff page defers reads and retains known photo');
  leave = cache.subscribe('staff-a',['a'],()=>{});
  check(photo('a') === verified, 'Dirty remount shows prior verified image while revalidating');
  await tick(); check(!photo('a') && state.revoked.includes(verified), 'Authoritative removal after return clears photo and releases URL');
  state.references.a = 'linked-a/avatar'; windowTarget.dispatchEvent(new Event('focus')); await tick();
  // Coalescing applies to focus/visibility at the same time, not delayed retries.
  await new Promise(resolve=>setTimeout(resolve,260)); windowTarget.dispatchEvent(new Event('focus')); await tick();
  check(!!photo('a'), 'Focus refresh retrieves an updated/restored photo');
  const before = state.rpc.length; leave(); cache.dispose(); windowTarget.dispatchEvent(new Event('focus')); await tick();
  check(state.rpc.length === before, 'Disposed cache removes background refresh listeners');
}
{
  const {loader,state,photo} = fixture(); loader.setPatientIds(['a']); await tick(); const verified = photo('a');
  const release = loader.retainUrls([verified]); await loader.refresh();
  check(photo('a') !== verified && !state.revoked.includes(verified), 'Replaced URL stays valid until its rendered consumer releases it');
  release(); release(); check(state.revoked.filter(url=>url===verified).length === 1, 'Released URL revoked exactly once');
  const retained = photo('a'); state.rpcError = true; await loader.refresh();
  check(photo('a') === retained && !state.revoked.includes(retained), 'Failed metadata refresh preserves last-good verified photo');
  state.rpcError = {code:'42501',message:'Synthetic access denial'}; await loader.refresh();
  check(!photo('a') && state.revoked.includes(retained), 'Explicit metadata access denial clears formerly cached private image');
  state.rpcError = false; await loader.refresh(); const recovered = photo('a');
  state.rpcError = false; state.downloadError = true; await loader.refresh();
  check(!photo('a') && state.revoked.includes(recovered), 'Authoritative reference with denied download falls back safely'); loader.dispose();
}
function clock() {
  let time = 0, next = 0; const timers = new Map();
  return {now:()=>time,setTimer(fn,delay){const id=++next;timers.set(id,{fn,at:time+delay});return id},clearTimer(id){timers.delete(id)},
    async advance(amount){const target=time+amount;let selected;while((selected=[...timers].filter(([,item])=>item.at<=target).sort((a,b)=>a[1].at-b[1].at)[0])){time=selected[1].at;timers.delete(selected[0]);selected[1].fn();await tick()}time=target;await tick()},count:()=>timers.size};
}
{
  const time = clock(), {cache,state,photo} = fixture({cache:true,loaderOptions:{...time,cacheTtlMs:1000}});
  const leave = cache.subscribe('staff-a',['a'],()=>{}); await tick(); await time.advance(0); const verified = photo('a');
  await time.advance(2000); check(photo('a') === verified, 'Visible photo never expires beneath its consumer');
  leave(); await time.advance(999); check(photo('a') === verified, 'Unused photo retained until idle TTL');
  await time.advance(1); check(!photo('a') && state.revoked.includes(verified), 'Idle expiry releases unused bytes');
  check(state.unsubscribed && time.count() === 0, 'Idle expiry cleans auth listener and all cache timers');
  const again = cache.subscribe('staff-a',['a'],()=>{}); await tick(); await time.advance(0);
  check(!!photo('a') && photo('a') !== verified, 'Expired cache performs genuine fresh load'); again(); cache.dispose();
}
for (const limit of [{maxEntries:1},{maxBytes:60}]) {
  const {loader,state,photo} = fixture({loaderOptions:limit}); state.references.b = 'linked-b/avatar';
  loader.setPatientIds(['a']); await tick(); const first = photo('a');
  loader.setPatientIds(['b']); await tick();
  check(!!photo('b') && !photo('a') && state.revoked.includes(first), 'Cache budget evicts least-recent unused image: '+JSON.stringify(limit));
  loader.dispose();
}
for (const boundary of ['rpc','download']) {
  const {cache,state,photo} = fixture({cache:true}); const pending = gate(); state[boundary+'Gate'] = pending;
  const leave = cache.subscribe('staff-a',['a'],()=>{}); await tick(); leave();
  check(!state.unsubscribed, boundary+': auth fence remains active while route is detached');
  state.emit(null);
  pending.resolve(boundary === 'rpc' ? {data:[{patient_id:'a',avatar_url:'linked-a/avatar'}],error:null} : {data:{type:'image/png',size:10,version:99},error:null}); await tick();
  check(!photo('a') && !state.created.length, boundary+': detached logout fences late data'); cache.dispose();
}
{
  const {loader,state,photo} = fixture(); await tick(); const pending = gate(); state.rpcGate = pending;
  loader.setPatientIds(['a']); await tick(); state.references.a = 'linked-a/updated';
  void loader.invalidate(); void loader.invalidate();
  pending.resolve({data:[{patient_id:'a',avatar_url:'linked-a/old'}],error:null}); await tick();
  check(state.rpc.length === 2 && state.downloads.at(-1).path === 'linked-a/updated' && !!photo('a'), 'Photo invalidations during a pending read coalesce into one authoritative follow-up');
  loader.dispose();
}
console.log(`PASS: ${checks} mocked Staff request avatar assertions; storage permissions not changed or live-verified.`);
