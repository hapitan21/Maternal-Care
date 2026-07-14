export const staffSettingsKey = "staff_dashboard_settings";
export const staffSettingsUpdatedEvent = "staff-settings-updated";

export const defaultStaffSettings = {
  displayName: "Kempee Vergara",
  email: "kempoyvergara@gmail.com",
  gender: "Female",
  birthdate: "January 10, 1990",
  nationality: "Filipino",
  civilStatus: "Married",
  yearsExperience: "8 Years",
  doctorId: "DOC-2023-001",
  boardCertification: "Obstetrics and Gynecology",
  licenseNumber: "1234567",
  clinicName: "La Paz Health Center",
  clinicAddress: "La Paz, Iloilo City, Philippines 5000",
  contactNumber: "0912 345 6789",
  twoFactorAuth: true,
  loginNotifications: true,
};

export function getStaffSettings() {
  try {
    const saved = window.localStorage.getItem(staffSettingsKey);
    return {
      ...defaultStaffSettings,
      ...(saved ? JSON.parse(saved) : {}),
    };
  } catch {
    return defaultStaffSettings;
  }
}

export function saveStaffSettings(settings) {
  window.localStorage.setItem(staffSettingsKey, JSON.stringify(settings));
  window.dispatchEvent(new Event(staffSettingsUpdatedEvent));
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
