export const staffSettingsKey = "staff_dashboard_settings";

export const staffSettingsUpdatedEvent = "staff-settings-updated";

export const defaultStaffSettings = {
  displayName: "",
  email: "",
  gender: "",
  birthdate: "",
  nationality: "",
  civilStatus: "",
  address: "",
  employeeId: "",
  position: "",
  dateHired: "",
  employmentStatus: "",
  clinicName: "",
  clinicAddress: "",
  contactNumber: "",
  twoFactorAuth: false,
  loginNotifications: false,

  // Legacy keys are kept blank so older call sites do not crash while Staff
  // pages move to Staff-owned fields.
  yearsExperience: "",
  doctorId: "",
  boardCertification: "",
  licenseNumber: "",
};

/*
 * In-memory UI snapshot.
 *
 * Supabase is still the permanent source of truth. localStorage is retained
 * only as a compatibility/UI cache for older Staff components.
 */
let staffSettingsMemoryCache = null;
let staffSettingsOwnerUserId = "";

function normalizeSavedStaffSettings(savedSettings = {}) {
  return {
    ...defaultStaffSettings,
    ...savedSettings,
    twoFactorAuth: Boolean(savedSettings.twoFactorAuth),
    loginNotifications: Boolean(savedSettings.loginNotifications),
  };
}

function readLocalStaffSettings() {
  try {
    const saved = window.localStorage.getItem(staffSettingsKey);

    return normalizeSavedStaffSettings(
      saved ? JSON.parse(saved) : {}
    );
  } catch {
    return {
      ...defaultStaffSettings,
    };
  }
}

function emitStaffSettingsUpdated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new Event(staffSettingsUpdatedEvent)
    );
  }
}

export function getStaffSettings() {
  if (staffSettingsMemoryCache) {
    return {
      ...staffSettingsMemoryCache,
    };
  }

  staffSettingsMemoryCache = readLocalStaffSettings();

  return {
    ...staffSettingsMemoryCache,
  };
}

/*
 * Update only the in-memory Staff snapshot.
 *
 * This is useful after Supabase reads because it gives Dashboard/Profile/
 * Settings the same already-loaded data without treating localStorage as the
 * database.
 */
export function cacheStaffSettings(
  settings,
  { broadcast = true } = {}
) {
  staffSettingsMemoryCache =
    normalizeSavedStaffSettings(settings);

  if (broadcast) {
    emitStaffSettingsUpdated();
  }

  return {
    ...staffSettingsMemoryCache,
  };
}

/*
 * Seed the shared Staff snapshot from the already-authorized Supabase profile.
 * The authorization hook calls this before StaffDashboard renders.
 */
export function hydrateStaffSettingsFromIdentity(
  identity,
  { broadcast = true } = {}
) {
  const profile = identity?.profile || {};
  const authUser = identity?.authUser || {};
  const userId = String(authUser.id || profile.id || "").trim();
  const identityEmail = String(profile.email || authUser.email || "")
    .trim()
    .toLowerCase();
  let current = getStaffSettings();
  const cachedEmail = String(current.email || "").trim().toLowerCase();

  if (
    (staffSettingsOwnerUserId && staffSettingsOwnerUserId !== userId) ||
    (!staffSettingsOwnerUserId && cachedEmail && identityEmail && cachedEmail !== identityEmail)
  ) {
    staffSettingsMemoryCache = { ...defaultStaffSettings };
    current = { ...defaultStaffSettings };
  }

  staffSettingsOwnerUserId = userId;

  const currentName = String(current.displayName || "").trim();
  const profileName = String(profile.full_name || "").trim();
  const metadataName = String(
    authUser.user_metadata?.full_name ||
      authUser.user_metadata?.name ||
      ""
  ).trim();

  const isGenericStaffName = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return !normalized || normalized === "staff" || normalized === "staff account";
  };

  /*
   * Never replace a richer Staff personal-information name (for example
   * "Freian Hapitan") with a generic profiles.full_name such as
   * "Staff Account".
   */
  const displayName = !isGenericStaffName(currentName)
    ? currentName
    : !isGenericStaffName(profileName)
      ? profileName
      : !isGenericStaffName(metadataName)
        ? metadataName
        : currentName || profileName || metadataName || "";

  const next = {
    ...current,
    displayName,
    email:
      profile.email ||
      authUser.email ||
      current.email ||
      "",
  };

  return cacheStaffSettings(next, { broadcast });
}

export function clearStaffSettingsMemoryCache() {
  staffSettingsMemoryCache = null;
  staffSettingsOwnerUserId = "";
}

/*
 * Compatibility helper for existing Settings code.
 *
 * The Settings page must save to Supabase first, then call this helper to
 * update the local UI cache. localStorage is not the authoritative source.
 */
export function saveStaffSettings(settings) {
  const normalized =
    normalizeSavedStaffSettings(settings);

  staffSettingsMemoryCache = normalized;

  try {
    window.localStorage.setItem(
      staffSettingsKey,
      JSON.stringify(normalized)
    );
  } catch {
    // The in-memory cache still works if localStorage is unavailable.
  }

  emitStaffSettingsUpdated();

  return {
    ...normalized,
  };
}

export function getStaffInitials(name) {
  const initials = String(name || "Staff")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "ST";
}
