import { profilePictureBucket, profilePictureUpdatedEvent, validateProfilePicture } from "./profilePicture";
import { getLogicalSessionIdentity } from "./roleInactivity";

// Resolve only the reference returned by the existing patient-avatar RPC.
// Never derive an object path from a patient name/ID or use a public image URL.
export function getPatientAvatarStoragePath(reference, supabaseUrl) {
  let path = String(reference || "").trim();
  if (!path) return "";
  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      if (url.origin !== new URL(supabaseUrl).origin) return "";
      const prefix = `/storage/v1/object/`;
      const match = url.pathname.slice(prefix.length).match(/^(?:public|authenticated|sign)\/([^/]+)\/(.+)$/);
      if (!url.pathname.startsWith(prefix) || !match || match[1] !== profilePictureBucket) return "";
      path = match[2].split("/").map(decodeURIComponent).join("/");
    } else {
      path = path.replace(/^\/+/, "");
      if (path.startsWith(`${profilePictureBucket}/`)) path = path.slice(profilePictureBucket.length + 1);
    }
    if (!path || /[:?#\\]/.test(path) || [...path].some(character => character.charCodeAt(0) < 32) || path.split("/").some(part => !part || part === "." || part === "..")) return "";
    return path;
  } catch {
    return "";
  }
}

const avatarCacheLifetime = 5 * 60 * 1000;

// Session-bound bytes stay in memory only. Visible consumers lease their URLs.
export function createStaffRequestAvatarLoader({
  client, userId, onChange,
  createObjectUrl = blob => URL.createObjectURL(blob),
  revokeObjectUrl = url => URL.revokeObjectURL(url),
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  cacheTtlMs = avatarCacheLifetime, maxEntries = 50, maxBytes = 32 * 1024 * 1024,
}) {
  let active = true, identity = "", epoch = 0, authEvents = 0, requestSerial = 0, sessionKnown = false;
  let patientIds = [], pending = null, queued = false, queuedForce = false, timer, expiryTimer;
  const photos = new Map(), urls = new Set(), sizes = new Map(), touched = new Map(), leases = new Map();
  const publish = () => { if (active) onChange({ identity, resolved: sessionKnown, photos: new Map(photos) }); };
  const prune = () => {
    const retained = new Set(photos.values());
    for (const url of urls) if (!retained.has(url) && !leases.has(url)) { revokeObjectUrl(url); urls.delete(url); sizes.delete(url); }
  };
  const expire = () => {
    clearTimer(expiryTimer);
    const unused = [...photos.keys()].filter(id => !patientIds.includes(id)).sort((a, b) => touched.get(a) - touched.get(b));
    const byteCount = () => [...new Set(photos.values())].reduce((total, url) => total + (sizes.get(url) || 0), 0);
    let changed = false;
    for (const id of unused) {
      if (now() - touched.get(id) >= cacheTtlMs || photos.size > maxEntries || byteCount() > maxBytes) {
        photos.delete(id); touched.delete(id); changed = true;
      }
    }
    if (changed) publish();
    prune();
    const deadlines = [...photos.keys()].filter(id => !patientIds.includes(id)).map(id => touched.get(id) + cacheTtlMs);
    if (active && deadlines.length) expiryTimer = setTimer(expire, Math.max(1, Math.min(...deadlines) - now()));
  };
  const reset = next => {
    epoch++; pending?.abort.abort(); pending = null; queued = false; queuedForce = false;
    clearTimer(expiryTimer); identity = next; photos.clear(); touched.clear(); leases.clear(); prune(); publish();
  };
  const schedule = () => {
    clearTimer(timer);
    timer = setTimer(() => { void refresh(true); }, 0);
  };
  const acceptSession = session => {
    if (!active) return;
    const next = session?.user?.id === userId ? getLogicalSessionIdentity(session) : "";
    const first = !sessionKnown;
    sessionKnown = true;
    if (next === identity) { if (first) publish(); return; }
    reset(next);
    if (next) schedule();
  };
  const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
    authEvents++; acceptSession(session);
  });
  const initialEvents = authEvents;
  void client.auth.getSession().then(result => {
    if (active && authEvents === initialEvents) acceptSession(result.error ? null : result.data?.session);
  }).catch(() => { if (active && authEvents === initialEvents) acceptSession(null); });

  function refresh(force = true, invalidated = false) {
    if (!active || !identity || !patientIds.length) return Promise.resolve();
    if (pending) {
      if (patientIds.some(id => !photos.has(id) && !pending.ids.includes(id))) queued = true;
      if (invalidated) { queued = true; queuedForce = true; }
      return pending.promise;
    }
    const ids = patientIds.filter(id => force || !photos.has(id));
    if (!ids.length) return Promise.resolve();
    const operation = { epoch, ids, abort: new AbortController() };
    const current = () => active && operation.epoch === epoch;
    pending = operation;
    operation.promise = Promise.resolve().then(async () => {
      if (!current()) return;
      let query = client.rpc("get_patient_avatar_urls", { p_patient_ids: ids });
      if (typeof query.abortSignal === "function") query = query.abortSignal(operation.abort.signal);
      const { data, error } = await query;
      if (!current()) return;
      if (error) throw error;
      const references = new Map((data || []).filter(row => ids.includes(String(row.patient_id))).map(row => [String(row.patient_id), row.avatar_url]));
      const downloads = new Map();
      const nextPhotos = await Promise.all(ids.map(async id => {
        const path = getPatientAvatarStoragePath(references.get(id), client.supabaseUrl);
        if (!path) return [id, ""];
        if (!downloads.has(path)) downloads.set(path, (async () => {
          try {
            if (!current()) return "";
            const { data: blob, error: downloadError } = await client.storage.from(profilePictureBucket).download(
              path, { cacheNonce: `${Date.now()}-${epoch}-${++requestSerial}` }, { cache: "no-store", signal: operation.abort.signal }
            );
            if (!current() || downloadError || !blob) return "";
            validateProfilePicture(blob);
            const url = createObjectUrl(blob); urls.add(url); sizes.set(url, blob.size); return url;
          } catch { return ""; }
        })());
        return [id, await downloads.get(path)];
      }));
      if (!current()) { prune(); return; }
      for (const [id, url] of nextPhotos) { photos.set(id, url); touched.set(id, now()); }
      publish(); expire();
    }).catch(error => {
      if (!current()) return;
      const denied = ["42501", "PGRST301"].includes(error?.code) || [401, 403].includes(Number(error?.status || error?.statusCode));
      // A network failure cannot prove removal; explicit access denial clears it.
      for (const id of ids) if (denied || !photos.has(id)) { photos.set(id, ""); touched.set(id, now()); }
      publish(); expire();
    }).finally(() => {
      if (pending !== operation) return;
      pending = null;
      if (active && queued) {
        const forceNext = queuedForce; queued = false; queuedForce = false; void refresh(forceNext);
      }
    });
    return operation.promise;
  }
  return {
    refresh,
    invalidate() { return refresh(true, true); },
    setPatientIds(ids, force = false) {
      const nextIds = [...new Set(ids.filter(Boolean).map(String))];
      for (const id of [...patientIds, ...nextIds]) if (photos.has(id)) touched.set(id, now());
      patientIds = nextIds; expire(); void refresh(force, force);
    },
    retainUrls(values) {
      const retained = [...new Set(values)].filter(url => urls.has(url));
      for (const url of retained) leases.set(url, (leases.get(url) || 0) + 1);
      let released = false;
      return () => {
        if (released) return; released = true;
        for (const url of retained) {
          const count = leases.get(url) || 0;
          if (count <= 1) leases.delete(url); else leases.set(url, count - 1);
        }
        prune();
      };
    },
    dispose() { active = false; epoch++; clearTimer(timer); clearTimer(expiryTimer); pending?.abort.abort(); subscription.unsubscribe(); photos.clear(); touched.clear(); leases.clear(); prune(); },
  };
}

const emptySnapshot = { identity: "", resolved: false, photos: new Map() };

// One cache per Supabase client. Its auth listener survives route unmounts so
// logout elsewhere clears private bytes before another page can reuse them.
export function createStaffRequestAvatarCache({
  client, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  cacheTtlMs = avatarCacheLifetime,
  windowTarget = typeof window === "undefined" ? null : window,
  documentTarget = typeof document === "undefined" ? null : document,
  ...loaderOptions
}) {
  let record;
  function dispose(current) {
    if (!current) return;
    clearTimer(current.idleTimer); clearTimer(current.refreshTimer);
    windowTarget?.removeEventListener("focus", current.refresh);
    documentTarget?.removeEventListener("visibilitychange", current.refresh);
    windowTarget?.removeEventListener(profilePictureUpdatedEvent, current.refresh);
    current.loader.dispose();
    if (record === current) record = undefined;
    for (const { listener } of current.consumers.values()) listener();
  }
  function activate(userId) {
    if (record?.userId === userId) return record;
    dispose(record);
    const current = { userId, snapshot: emptySnapshot, consumers: new Map(), dirty: false, lastRefresh: -Infinity };
    record = current;
    const ids = () => [...new Set([...current.consumers.values()].flatMap(consumer => consumer.ids))];
    current.loader = createStaffRequestAvatarLoader({ ...loaderOptions, client, userId, now, setTimer, clearTimer, cacheTtlMs,
      onChange(snapshot) {
        current.snapshot = snapshot;
        for (const { listener } of current.consumers.values()) listener();
      },
    });
    current.sync = () => {
      const patientIds = ids();
      current.loader.setPatientIds(patientIds, patientIds.length > 0 && current.dirty);
      if (patientIds.length) current.dirty = false;
    };
    current.refresh = event => {
      if (documentTarget && documentTarget.visibilityState !== "visible") return;
      current.invalidated ||= event?.type === profilePictureUpdatedEvent;
      clearTimer(current.refreshTimer);
      current.refreshTimer = setTimer(() => {
        const invalidated = current.invalidated; current.invalidated = false;
        if (!ids().length) { current.dirty = true; return; }
        if (!invalidated && now() - current.lastRefresh < 250) return;
        current.lastRefresh = now();
        if (invalidated) void current.loader.invalidate(); else void current.loader.refresh();
      }, 0);
    };
    windowTarget?.addEventListener("focus", current.refresh);
    documentTarget?.addEventListener("visibilitychange", current.refresh);
    windowTarget?.addEventListener(profilePictureUpdatedEvent, current.refresh);
    return current;
  }
  return {
    getSnapshot(userId) { return record?.userId === userId ? record.snapshot : emptySnapshot; },
    subscribe(userId, patientIds, listener, enabled = true) {
      if (!userId || (!enabled && record?.userId !== userId)) return () => {};
      const current = activate(userId), token = {};
      clearTimer(current.idleTimer);
      current.consumers.set(token, { ids: enabled ? patientIds : [], listener });
      current.sync();
      return () => {
        current.consumers.delete(token);
        if (record !== current) return;
        current.sync();
        if (!current.consumers.size) current.idleTimer = setTimer(() => dispose(current), cacheTtlMs);
      };
    },
    retainUrls(userId, values) { return record?.userId === userId ? record.loader.retainUrls(values) : () => {}; },
    dispose() { dispose(record); },
  };
}

const clientCaches = new WeakMap();
export function getStaffRequestAvatarCache(client) {
  if (!clientCaches.has(client)) clientCaches.set(client, createStaffRequestAvatarCache({ client }));
  return clientCaches.get(client);
}
