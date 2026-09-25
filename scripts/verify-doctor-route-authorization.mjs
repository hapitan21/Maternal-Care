import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getDoctorRouteAuthorization,
} from "../src/lib/doctorRouteAuthorization.js";

const activeUser = { id: "00000000-0000-4000-8000-000000000001" };

function decide(role, accountStatus = "active") {
  return getDoctorRouteAuthorization({
    user: activeUser,
    profile: {
      id: activeUser.id,
      role,
      account_status: accountStatus,
    },
  });
}

assert.equal(decide(" Doctor ", " ACTIVE ").authorized, true);
assert.equal(decide("staff").redirectTo, "/staff/dashboard");
assert.equal(decide("admin").redirectTo, "/admin/dashboard");
assert.equal(decide("patient").redirectTo, "/patient");
assert.equal(decide("doctor", "inactive").redirectTo, "/login?reason=doctor_inactive");
assert.equal(decide("doctor", "").authorized, false);
assert.equal(
  getDoctorRouteAuthorization({ user: activeUser, profile: null }).redirectTo,
  "/login"
);
assert.equal(getDoctorRouteAuthorization().redirectTo, "/login");

const repositoryRoot = new URL("../", import.meta.url);
const appSource = readFileSync(new URL("src/App.jsx", repositoryRoot), "utf8");
const hookSource = readFileSync(
  new URL("src/hooks/useDoctorRouteAuthorization.js", repositoryRoot),
  "utf8"
);

const doctorRouteStart = appSource.indexOf("function DoctorRoute()");
const doctorRouteEnd = appSource.indexOf("function PatientRoute()", doctorRouteStart);
assert.ok(doctorRouteStart >= 0 && doctorRouteEnd > doctorRouteStart);

const doctorRouteSource = appSource.slice(doctorRouteStart, doctorRouteEnd);
const loadingGuardMatch = doctorRouteSource.match(
  /if\s*\(\s*doctorAccess\.loading\s*&&\s*!doctorAccess\.authorized\s*\)/
);
const denialGuardMatch = doctorRouteSource.match(
  /if\s*\(\s*!doctorAccess\.loading\s*&&\s*!doctorAccess\.authorized\s*\)/
);
const loadingGuardIndex = loadingGuardMatch?.index ?? -1;
const denialGuardIndex = denialGuardMatch?.index ?? -1;
const dashboardMountIndex = doctorRouteSource.indexOf("<DoctorDashboard");
assert.ok(loadingGuardIndex >= 0);
assert.ok(denialGuardIndex > loadingGuardIndex);
assert.ok(dashboardMountIndex > denialGuardIndex);

const protectedDoctorRoutes = appSource.match(
  /<Route\s+path="\/doctor\/\*"\s+element=\{<DoctorRoute\s*\/>\}\s*\/>/g
) || [];
assert.equal(
  protectedDoctorRoutes.length,
  1,
  "The persistent /doctor/* branch must use DoctorRoute exactly once"
);

assert.match(hookSource, /useState\(createLoadingState\)/);
assert.match(hookSource, /\.select\("id, role, account_status"\)/);
assert.doesNotMatch(hookSource, /\.from\("patients"\)/);
assert.doesNotMatch(hookSource, /\.from\("medical_records"\)/);

console.log("Doctor route authorization verification passed.");
console.log("Verified the persistent /doctor/* Doctor route branch.");
console.log(`Verification script: ${fileURLToPath(import.meta.url)}`);
