const adminWorkspaceSnapshotStores = new Map();

function cleanKeyPart(value) {
  return String(value ?? "").trim();
}

function getStore(namespace) {
  const cleanNamespace = cleanKeyPart(namespace);
  if (!cleanNamespace) return null;

  if (!adminWorkspaceSnapshotStores.has(cleanNamespace)) {
    adminWorkspaceSnapshotStores.set(cleanNamespace, new Map());
  }

  return adminWorkspaceSnapshotStores.get(cleanNamespace);
}

function createSnapshotKey(adminId, queryKey = "default") {
  const cleanAdminId = cleanKeyPart(adminId);
  if (!cleanAdminId) return "";
  return `${cleanAdminId}::${cleanKeyPart(queryKey) || "default"}`;
}

export function getAdminWorkspaceSnapshot(namespace, adminId, queryKey) {
  const store = getStore(namespace);
  const snapshotKey = createSnapshotKey(adminId, queryKey);
  if (!store || !snapshotKey || !store.has(snapshotKey)) return null;
  return store.get(snapshotKey);
}

export function setAdminWorkspaceSnapshot(namespace, adminId, queryKey, snapshot) {
  const store = getStore(namespace);
  const snapshotKey = createSnapshotKey(adminId, queryKey);
  if (!store || !snapshotKey) return;
  store.set(snapshotKey, snapshot);
}

export function clearAdminWorkspaceSnapshots(namespace, adminId) {
  const cleanNamespace = cleanKeyPart(namespace);
  const cleanAdminId = cleanKeyPart(adminId);

  if (!cleanNamespace) {
    adminWorkspaceSnapshotStores.clear();
    return;
  }

  const store = adminWorkspaceSnapshotStores.get(cleanNamespace);
  if (!store) return;

  if (!cleanAdminId) {
    store.clear();
    return;
  }

  const keyPrefix = `${cleanAdminId}::`;
  for (const key of store.keys()) {
    if (key.startsWith(keyPrefix)) store.delete(key);
  }
}
