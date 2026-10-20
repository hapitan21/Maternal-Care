import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearPatientPwaSessionCache, getPatientPwaSessionCacheGeneration } from "../src/lib/patientPwaSessionCache.js";
import { readPatientHealthTipsCache, savePatientHealthTipsCache, retainPatientHealthTipsOnError } from "../src/lib/patientHealthTipsCache.js";

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
clearPatientPwaSessionCache();
check(!readPatientHealthTipsCache("patient-a"), "Cold load has no cached result");
const result = { patientId: "patient-a", tips: [{ id: "synthetic", text: "Synthetic guidance" }] };
savePatientHealthTipsCache(result);
check(readPatientHealthTipsCache("patient-a") === result, "Remount restores successful same-patient tips");
check(readPatientHealthTipsCache("patient-b") === null, "Another patient cannot read cached tips");
check(retainPatientHealthTipsOnError("patient-a", { message: "Network failure" }) === result, "Transient errors retain data");
savePatientHealthTipsCache({ patientId: "patient-a", tips: [] });
check(readPatientHealthTipsCache("patient-a")?.tips.length === 0, "Empty success replaces outdated tips and remains loaded");
for (const error of [{ status: 401 }, { status: 403 }, { code: "42501" }, { code: "PGRST301" }]) {
  savePatientHealthTipsCache(result);
  check(retainPatientHealthTipsOnError("patient-a", error).tips.length === 0 && !readPatientHealthTipsCache("patient-a"), "Authorization errors clear cached tips");
}
savePatientHealthTipsCache(result);
const generation = getPatientPwaSessionCacheGeneration();
clearPatientPwaSessionCache();
check(!readPatientHealthTipsCache("patient-a"), "Logout clears tips");
check(generation !== getPatientPwaSessionCacheGeneration(), "Logout invalidates in-flight request generation");
savePatientHealthTipsCache({ patientId: "patient-b", tips: [] });
check(!readPatientHealthTipsCache("patient-a"), "Switching accounts never exposes prior patient's tips");
clearPatientPwaSessionCache();
const panel = readFileSync(new URL("../src/components/patient/PatientNotificationPanel.jsx", import.meta.url), "utf8");
const action = panel.slice(panel.indexOf('className="is-mark-all"'), panel.indexOf('Mark all read'));
check(action.includes('<Check width="1em" height="1em"') && !action.includes('check-read'), "Only mark-all uses the bundled single check at the original icon size");
check(action.includes("onClick={onMarkAllAsRead}") && action.includes("disabled={updating || !online}"), "Mark-all handler and disabled contract retained");
check(panel.includes('icon="solar:bell-bing-bold-duotone"'), "Popup bell unchanged");
console.log(`PASS: ${checks} cache and notification-action assertions; no network or database calls.`);
