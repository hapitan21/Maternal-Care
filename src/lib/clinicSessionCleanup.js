import { clearAdminWorkspaceSnapshots } from "./adminWorkspaceSnapshots";
import { clearDoctorSessionCaches } from "./doctorSessionCache";
import { clearStaffSessionCache } from "./staffSessionCache";
import { clearSensitiveStaffSettings } from "./staffProfile";

export function clearClinicSessionCaches() {
  clearAdminWorkspaceSnapshots();
  clearDoctorSessionCaches();
  clearStaffSessionCache();
  clearSensitiveStaffSettings();
  try {
    window.sessionStorage.removeItem("maternal_staff_patient_registration");
    window.sessionStorage.removeItem("maternal_staff_walkin_registration_slot");
  } catch { /* Storage can be unavailable; in-memory access is still removed. */ }
}
