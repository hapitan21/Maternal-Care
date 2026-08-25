export const doctorRouteRedirects = Object.freeze({
  admin: "/admin/dashboard",
  patient: "/patient",
  staff: "/staff/dashboard",
});

export function normalizeDoctorRouteAccessValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function denyDoctorRoute(reason, redirectTo = "/login", role = "") {
  return {
    authorized: false,
    reason,
    redirectTo,
    role,
    user: null,
    profile: null,
  };
}

export function getDoctorRouteAuthorization({
  user = null,
  profile = null,
  authError = null,
  profileError = null,
} = {}) {
  if (authError || !user?.id) {
    return denyDoctorRoute("doctor_not_authenticated");
  }

  if (profileError || !profile || String(profile.id) !== String(user.id)) {
    return denyDoctorRoute("doctor_profile_missing");
  }

  const role = normalizeDoctorRouteAccessValue(profile.role);
  if (role !== "doctor") {
    return denyDoctorRoute(
      "doctor_role_mismatch",
      doctorRouteRedirects[role] || "/login",
      role
    );
  }

  const accountStatus = normalizeDoctorRouteAccessValue(profile.account_status);
  if (accountStatus !== "active") {
    return denyDoctorRoute(
      "doctor_account_inactive",
      "/login?reason=doctor_inactive",
      role
    );
  }

  return {
    authorized: true,
    reason: "doctor_authorized",
    redirectTo: "",
    role,
    user,
    profile,
  };
}
