const staffSessionSnapshots = new Map();

let activeStaffUserId = "";

function normalizeStaffUserId(userId) {
  return String(userId || "").trim();
}

function cloneSnapshot(value) {
  if (value === undefined) return undefined;

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function selectStaffSession(userId) {
  const normalizedUserId = normalizeStaffUserId(userId);

  if (!normalizedUserId) return "";

  if (activeStaffUserId && activeStaffUserId !== normalizedUserId) {
    staffSessionSnapshots.clear();
  }

  activeStaffUserId = normalizedUserId;
  return normalizedUserId;
}

export function getStaffSessionSnapshot(userId, section) {
  const normalizedUserId = selectStaffSession(userId);

  if (!normalizedUserId || !section) return null;

  return cloneSnapshot(
    staffSessionSnapshots.get(`${normalizedUserId}:${section}`)
  ) || null;
}

export function setStaffSessionSnapshot(userId, section, snapshot) {
  const normalizedUserId = selectStaffSession(userId);

  if (!normalizedUserId || !section) return;

  staffSessionSnapshots.set(
    `${normalizedUserId}:${section}`,
    cloneSnapshot(snapshot)
  );
}

export function clearStaffSessionCache() {
  staffSessionSnapshots.clear();
  activeStaffUserId = "";
}
