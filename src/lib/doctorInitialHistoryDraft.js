// Pure Initial form mapping shared by the real interface and isolated preview.
// No database/auth client or persistence capability.
import { getAvailabilityDayOfWeek } from "./availabilitySchedule.js";
import { buildCanonicalClinicalVisitFormData } from "./clinicalVisitData.js";

export const reproductiveFields = [
  ["age_at_menarche", "Age at Menarche", "integer", 8, 25],
  ["menstrual_pattern", "Menstrual Pattern", "text"],
  ["cycle_length_days", "Cycle Length (days)", "integer", 15, 60],
  ["menstruation_duration_days", "Duration of Menstruation (days)", "integer", 1, 15],
  ["sexually_active", "Sexually Active", "boolean"],
  ["contraceptive_method", "Contraceptive Method Used", "text"],
];
export const obstetricCountFields = [
  ["gravida", "Gravida (G)", "integer"], ["para", "Para (P)", "integer"],
  ["full_term", "Full Term (T)", "integer"], ["preterm", "Preterm (P)", "integer"],
  ["abortion_miscarriage", "Abortion / Miscarriage (A)", "integer"],
  ["living_children", "Living Children (L)", "integer"],
];
export const pregnancyRecordFields = [
  ["birthdate", "Birthdate", "date"], ["termPreterm", "Term / Preterm", "text"],
  ["deliveryType", "Type of Delivery", "text"], ["deliveryPlace", "Place of Delivery", "text"],
  ["complications", "Complications", "text"], ["nbsResult", "NBS Result", "text"],
];
export const allergyRecordFields = [
  ["type", "Type", "text"], ["allergen", "Allergen", "text"], ["reaction", "Reaction", "text"],
];
const obstetricFields = [...reproductiveFields, ...obstetricCountFields,
  ["last_menstrual_period", "Last Menstrual Period", "date"],
  ["expected_delivery_date", "Expected Delivery Date", "date"]];
const medicalFields = [["other_medical_condition", "Other Medical Conditions", "text"],
  ["other_family_history", "Other / Unassigned Family History", "text"]];
export const encounterFields = ("gestationalAge expectedDeliveryDate pregnancyType riskLevel chiefComplaint bloodPressure temperature respiratoryRate weight height oxygenSaturation fundalHeight fetalHeartRate estimatedFetalWeight fetalMovement babyPosition additionalFindings hpvVaccinationStatus lastPapSmear otherClinicalNotes lifestyleAssessment smokingStatus drugUse physicalActivity alcoholIntake diet vaccinationStatus vaccinations laboratoryTestType laboratoryResultSummary laboratoryInterpretation laboratoryReportAttached laboratoryReview laboratoryAttachment ultrasoundVisitDate ultrasoundFindings ultrasoundReportAttached ultrasoundReview ultrasoundAttachment assessment diagnosis actionsTaken actionsOtherDetails actionSelections pregnancyJourneyUpdate journeyMilestones prescription medications prescriptionInstructions doctorOrder treatmentPlan").split(" ");
export const bloodTypes = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
export function updateInitialPreviewEncounter(current, field, value) {
  const next = { ...current, [field]: value };
  const fields = { laboratoryTestType: ["laboratoryReview", "testType"], laboratoryResultSummary: ["laboratoryReview", "resultSummary"],
    laboratoryInterpretation: ["laboratoryReview", "interpretation"], laboratoryReportAttached: ["laboratoryReview", "reportAttached"],
    ultrasoundVisitDate: ["ultrasoundReview", "visitDate"], ultrasoundFindings: ["ultrasoundReview", "findings"], ultrasoundReportAttached: ["ultrasoundReview", "reportAttached"] };
  if (fields[field]) {
    const [review, key] = fields[field];
    const original = current[review] && typeof current[review] === "object" ? current[review] : buildCanonicalClinicalVisitFormData(current)[review];
    next[review] = { ...original, [key]: value };
  }
  return next;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const cloneClinical = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class InitialHistoryError extends Error {
  constructor(message, fields = {}) { super(message); this.name = "InitialHistoryError"; this.fields = fields; }
}
function fail(message, field) { throw new InitialHistoryError(message, field ? { [field]: message } : {}); }
export function hasEnteredClinicalFacts(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (["number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.some(hasEnteredClinicalFacts);
  return Object.entries(value).some(([key, item]) => !["id", "_sourceIndex"].includes(key) && hasEnteredClinicalFacts(item));
}
export function calendarDate(value, label = "Date", field = "") {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || getAvailabilityDayOfWeek(value) < 0) fail(`${label} must be a real YYYY-MM-DD date.`, field);
  return value;
}
function scalar(value, [key, label, type, min = 0, max = 2147483647]) {
  const field = `history-${key}`;
  if (value == null || value === "") return null;
  if (type === "date") return calendarDate(value, label, field);
  if (type === "boolean") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    fail(`${label} must be Yes, No or Unknown.`, field);
  }
  if (type === "integer") {
    if (!["number", "string"].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) || Number(value) < min || Number(value) > max) {
      fail(`${label} must be a whole number from ${min} to ${max}, or left unknown.`, field);
    }
    return Number(value);
  }
  if (typeof value !== "string") fail(`${label} must be text.`, field);
  return value.trim() || null;
}

export function assertInitialContext(context, ids, { completed = false } = {}) {
  const s = context?.state;
  if (context?.contract !== "S4-A7A-v1" || !object(s) || !Array.isArray(s.obstetric) || !Array.isArray(s.medical)) fail("Authoritative history context is unavailable; retry loading.");
  if (![ids.appointmentId, ids.patientId, ids.doctorId].every((id) => uuidPattern.test(id || "")) ||
    s.appointment?.id !== ids.appointmentId || s.appointment?.patient_id !== ids.patientId ||
    s.appointment?.doctor_id !== ids.doctorId || s.patient?.id !== ids.patientId ||
    [...s.obstetric, ...s.medical].some((row) => row.patient_id !== ids.patientId || !uuidPattern.test(row.id || ""))) fail("Exact Doctor, patient and appointment linkage is required.");
  if (!completed && (s.record || !["checked_in", "checked-in", "checked in"].includes(s.appointment.status))) fail("This contract supports checked-in Initial creation only; amendments and Follow-Up are blocked.");
  if (completed && (s.appointment.status !== "completed" || s.record?.patient_id !== ids.patientId || s.record?.schedule_id !== ids.appointmentId || s.record?.doctor_id !== ids.doctorId)) fail("Authoritative completion readback has inconsistent linkage.");
  return s;
}
function emptyDomain() { return { action: "", id: "", base: {}, values: {}, dirty: [], additions: {} }; }
export function createInitialHistoryDraft(context) {
  return { obstetric: emptyDomain(), medical: emptyDomain(), bloodType: context.state.patient.blood_type ?? "",
    bloodDirty: false, pregnancy: { action: "", id: "" }, confirmEdd: false, reviewed: false };
}
export function chooseInitialHistory(draft, kind, selection, context) {
  const candidates = context.state[kind];
  if (!["obstetric", "medical"].includes(kind) || !Array.isArray(candidates)) fail("Unsupported history selection.");
  const next = cloneClinical(draft), domain = emptyDomain();
  if (selection.startsWith("select:")) {
    const id = selection.slice(7), row = candidates.find((item) => item.id === id);
    if (!row) fail("Select a history linked to this exact patient.", `history-${kind}-selection`);
    Object.assign(domain, { action: "select", id, base: cloneClinical(row), values: cloneClinical(row) });
  } else {
    if (!["", "create", "not_recorded", "retain_unresolved"].includes(selection)) fail("Unsupported history intent.");
    if (["create", "not_recorded"].includes(selection) && candidates.length) fail("Existing histories require explicit selection or unresolved review.", `history-${kind}-selection`);
    domain.action = selection;
  }
  next[kind] = domain;
  if (kind === "obstetric") { next.pregnancy = { action: "", id: "" }; next.confirmEdd = false; }
  next.reviewed = false;
  return next;
}
export function editInitialHistoryField(draft, kind, key, value) {
  const definitions = kind === "obstetric" ? obstetricFields : medicalFields;
  if (!definitions.some(([field]) => field === key) || !["create", "select"].includes(draft[kind]?.action)) fail("Choose an applicable history before editing.");
  const next = cloneClinical(draft); next[kind].values[key] = value;
  if (!next[kind].dirty.includes(key)) next[kind].dirty.push(key);
  next.reviewed = false;
  return next;
}
export function appendInitialHistory(draft, kind, key, item) {
  const allowed = kind === "obstetric" ? ["pregnancy_records"] : ["allergies", "allergy_records", "medical_conditions", "family_history"];
  if (!allowed.includes(key) || !["select", "create"].includes(draft[kind]?.action)) fail("Choose an applicable history before adding entries.");
  const next = cloneClinical(draft); next[kind].additions[key] = [...(next[kind].additions[key] || []), cloneClinical(item)]; next.reviewed = false; return next;
}
export function removePendingHistoryEntry(draft, kind, key, index) {
  const next = cloneClinical(draft); next[kind].additions[key] = (next[kind].additions[key] || []).filter((_, n) => n !== index); next.reviewed = false; return next;
}
export function familySide(entries, side) {
  const prefix = `${side}: `;
  return (Array.isArray(entries) ? entries : []).filter((value) => typeof value === "string" && value.startsWith(prefix)).map((value) => value.slice(prefix.length));
}
export function validateNewHistoryEntry(row, kind) {
  const fields = kind === "pregnancy_records" ? pregnancyRecordFields : allergyRecordFields;
  if (!object(row) || typeof row.id !== "string" || !row.id.trim() || Object.keys(row).some((key) => key !== "id" && !fields.some(([field]) => field === key))) fail("New history entries must have a stable ID and supported fields.");
  const result = { id: row.id };
  for (const definition of fields) if (Object.hasOwn(row, definition[0])) result[definition[0]] = scalar(row[definition[0]], definition);
  if (!hasEnteredClinicalFacts(result)) fail("Enter clinical information before adding a history entry.");
  if (kind === "allergy_records" && (!["medication", "food", "environmental", "insect", "latex", "chemical"].includes(result.type) || !result.allergen || !result.reaction)) fail("New allergies need Type, Allergen and Reaction.");
  return result;
}
function domainIntent(domain, kind, state, today) {
  const field = `history-${kind}-selection`;
  if (!["create", "select", "not_recorded", "retain_unresolved"].includes(domain.action)) fail("Explicitly select, enter or retain this history as unknown.", field);
  if (["create", "not_recorded"].includes(domain.action) && state[kind].length) fail("Existing histories cannot be concealed or duplicated.", field);
  const patch = {};
  if (["create", "select"].includes(domain.action)) {
    if (domain.action === "select" && !state[kind].some((row) => row.id === domain.id)) fail("The selected history no longer belongs to this patient.", field);
    const definitions = kind === "obstetric" ? obstetricFields : medicalFields;
    for (const key of domain.dirty) {
      const definition = definitions.find(([name]) => name === key);
      if (!definition) fail("Unsupported history field.");
      const value = scalar(domain.values[key], definition);
      if (!same(value, domain.base[key] ?? null)) patch[key] = value;
    }
    for (const [key, additions] of Object.entries(domain.additions)) if (additions.length) {
      const known = kind === "obstetric" ? ["pregnancy_records"] : ["allergies", "allergy_records", "medical_conditions", "family_history"];
      if (!known.includes(key) || (domain.base[key] != null && !Array.isArray(domain.base[key]))) fail("Legacy history format needs a separately reviewed adapter.");
      const fresh = additions.map((value) => {
        if (["pregnancy_records", "allergy_records"].includes(key)) return validateNewHistoryEntry(value, key);
        if (typeof value !== "string" || !value.trim()) fail("History list entries must contain text.");
        return value.trim();
      });
      patch[key] = [...cloneClinical(domain.base[key] || []), ...fresh];
      const ids = patch[key].filter(object).map((row) => row.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) fail("History entry IDs must be unique.");
    }
    if (kind === "obstetric") {
      const merged = { ...domain.base, ...patch };
      if (merged.para != null && merged.gravida != null && Number(merged.para) > Number(merged.gravida)) fail("Para cannot exceed known Gravida.", "history-para");
      if (patch.last_menstrual_period && patch.last_menstrual_period > today) fail("Last Menstrual Period cannot be in the future.", "history-last_menstrual_period");
    }
    if (domain.action === "create" && !hasEnteredClinicalFacts(patch)) fail("Enter applicable clinical facts or choose Not recorded / Unresolved. No placeholder row will be created.", field);
  } else if (domain.dirty.length || hasEnteredClinicalFacts(domain.additions)) fail("Unknown history intent cannot discard entered clinical information.", field);
  return { action: domain.action, ...(domain.id ? { id: domain.id } : {}), ...(["create", "select"].includes(domain.action) ? { patch } : {}) };
}

export function validateInitialEncounter(form) {
  const unsupported = Object.keys(form).filter((key) => !encounterFields.includes(key));
  if (unsupported.some((key) => key.startsWith("staffIntake") || key === "staffPrefillSource")) fail("Client-supplied Staff attribution is blocked. Use the exact server-owned intake revision.");
  if (unsupported.length) fail(`Unsupported client/legacy encounter fields require an approved adapter: ${unsupported.join(", ")}.`);
  const arrays = ["medications", "vaccinations", "actionSelections", "journeyMilestones"];
  const measurements = ["temperature", "respiratoryRate", "weight", "height", "oxygenSaturation", "fundalHeight", "fetalHeartRate", "estimatedFetalWeight"];
  for (const [key, value] of Object.entries(form)) if (!arrays.includes(key) && !["laboratoryReview", "ultrasoundReview", "laboratoryAttachment", "ultrasoundAttachment"].includes(key) &&
    value != null && typeof value !== "string" && !(measurements.includes(key) && typeof value === "number")) fail("Clinical text/scalar values must match the supported form schema.", key);
  for (const key of ["laboratoryAttachment", "ultrasoundAttachment"]) if (form[key] != null) fail("Attachment admission is blocked. No files can be uploaded through this contract.");
  for (const key of ["laboratoryReview", "ultrasoundReview"]) if (form[key]?.attachment != null || form[key]?.reportAttached === "Yes") fail("Attachment admission is blocked.");
  for (const key of ["laboratoryReview", "ultrasoundReview"]) if (object(form[key])) {
    const fields = key === "laboratoryReview" ? ["testType", "resultSummary", "interpretation", "reportAttached", "attachment"] : ["visitDate", "findings", "reportAttached", "attachment"];
    if (Object.entries(form[key]).some(([field, value]) => !fields.includes(field) || (field !== "attachment" && value != null && typeof value !== "string"))) fail("Unsupported nested diagnostic data requires a reviewed adapter.");
    if (key === "ultrasoundReview") calendarDate(form[key].visitDate, "Ultrasound date");
    const flat = key === "laboratoryReview" ? { testType: "laboratoryTestType", resultSummary: "laboratoryResultSummary", interpretation: "laboratoryInterpretation", reportAttached: "laboratoryReportAttached" } : { visitDate: "ultrasoundVisitDate", findings: "ultrasoundFindings", reportAttached: "ultrasoundReportAttached" };
    for (const [nested, scalarKey] of Object.entries(flat)) if (Object.hasOwn(form[key], nested) && Object.hasOwn(form, scalarKey) &&
      (String(form[key][nested] ?? "").trim() || null) !== (String(form[scalarKey] ?? "").trim() || null)) fail("Diagnostic flat/nested values disagree; no clinical information will be discarded.");
  }
  for (const key of ["actionSelections", "journeyMilestones"]) if (form[key] != null && (!Array.isArray(form[key]) || form[key].some((value) => typeof value !== "string" || !value.trim()))) fail("Clinical selections must be meaningful text entries.");
  for (const key of ["laboratoryReportAttached", "ultrasoundReportAttached"]) {
    if (form[key] === "Yes") fail("Attachment admission is blocked. No files can be uploaded through this contract.");
    if (![undefined, null, "", "No"].includes(form[key])) fail("Unsupported report status.");
  }
  const encounter = buildCanonicalClinicalVisitFormData(form);
  for (const key of ["chiefComplaint", "assessment", "diagnosis", "treatmentPlan"]) if (typeof encounter[key] !== "string" || !encounter[key].trim()) fail("Chief Complaint, Assessment, Diagnosis and Plan / Treatment are required.", key);
  for (const key of ["expectedDeliveryDate", "lastPapSmear", "ultrasoundVisitDate"]) calendarDate(encounter[key], key, key);
  if (![undefined, null, "", "Low Risk", "Moderate Risk", "High Risk"].includes(form.riskLevel)) fail("Unsupported risk level.", "riskLevel");
  for (const [key, fields, name] of [["medications", ["medication", "dosage", "frequency", "duration"], "medication"], ["vaccinations", ["vaccineName", "lotNumber", "dateGiven"], "vaccineName"]]) {
    if (!Array.isArray(form[key] ?? [])) fail("Medication/vaccination lists must be arrays.");
    for (const row of form[key] || []) {
      if (!object(row) || typeof row[name] !== "string" || !row[name].trim() || Object.entries(row).some(([field, value]) => !fields.includes(field) || (value != null && typeof value !== "string"))) fail("Medication/vaccination rows contain unsupported or malformed fields.");
      if (key === "vaccinations") calendarDate(row.dateGiven, "Vaccine date");
    }
  }
  for (const key of ["temperature", "respiratoryRate", "weight", "height", "oxygenSaturation", "fundalHeight", "fetalHeartRate", "estimatedFetalWeight"]) {
    const value = encounter[key];
    if (value != null && value !== "" && (!/^[0-9]+(\.[0-9]+)?$/.test(String(value)) || Number(value) > 10000 ||
      (key === "respiratoryRate" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 100)) ||
      (key === "temperature" && (Number(value) < 30 || Number(value) > 45)) || (key === "oxygenSaturation" && Number(value) > 100))) fail("Use a numeric measurement supported by the candidate; unit suffixes and comma decimals need an approved adapter.", key);
  }
  return encounter;
}
export function buildInitialHistoryRequest(context, draft, form, ids, today) {
  const state = assertInitialContext(context, ids);
  if (!calendarDate(today, "Clinic today")) fail("The Manila clinic date is required for validation.");
  if (!draft.reviewed) fail("Review the selected histories and explicit unknown states before saving.", "history-reviewed");
  const obstetric = domainIntent(draft.obstetric, "obstetric", state, today), medical = domainIntent(draft.medical, "medical", state, today);
  const pregnancy = cloneClinical(draft.pregnancy), encounter = validateInitialEncounter(form);
  if (!["establish_active", "confirm_existing", "retain_unresolved", "not_recorded"].includes(pregnancy.action)) fail("Explicitly choose the pregnancy intent.", "history-pregnancy-intent");
  if (["establish_active", "confirm_existing"].includes(pregnancy.action) && !["create", "select"].includes(obstetric.action)) fail("Pregnancy establishment needs an applicable entered/selected obstetric history.");
  if (pregnancy.action === "establish_active" && state.context?.pregnancy_id) fail("An active pregnancy already exists; lifecycle changes are blocked.");
  if (pregnancy.action === "confirm_existing" && (pregnancy.id !== state.context?.pregnancy_id || obstetric.id !== state.context?.obstetric_id)) fail("Confirm the exact current pregnancy and selected obstetric history.");
  if (!draft.confirmEdd && (obstetric.patch?.expected_delivery_date != null || encounter.expectedDeliveryDate)) {
    const current = state.obstetric.find((row) => row.id === obstetric.id)?.expected_delivery_date ?? state.patient.expected_delivery_date;
    if (encounter.expectedDeliveryDate !== current || (obstetric.patch?.expected_delivery_date && obstetric.patch.expected_delivery_date !== current)) fail("Explicitly confirm the reviewed Expected Delivery Date.", "history-confirm-edd");
  }
  const knownEdd = state.obstetric.find((row) => row.id === obstetric.id)?.expected_delivery_date || state.patient.expected_delivery_date;
  if (knownEdd && !encounter.expectedDeliveryDate) fail("A known EDD cannot be silently cleared.", "expectedDeliveryDate");
  if (draft.confirmEdd && !encounter.expectedDeliveryDate) fail("EDD confirmation requires a real date.", "history-confirm-edd");
  if (!["establish_active", "confirm_existing"].includes(pregnancy.action) && (encounter.expectedDeliveryDate || encounter.riskLevel || obstetric.patch?.expected_delivery_date || draft.confirmEdd)) fail("Dating/risk writes require an explicitly reviewed current pregnancy.");
  if (draft.bloodDirty && draft.bloodType !== "" && !bloodTypes.includes(draft.bloodType)) fail("Choose a supported blood type or Unknown.", "history-blood-type");
  return { contract: "S4-A7A-v1", patient_id: ids.patientId, expected: cloneClinical(state), reviewed: true,
    encounter, obstetric, medical, pregnancy, blood: draft.bloodDirty ? { blood_type: draft.bloodType || null } : {}, confirm_edd: Boolean(draft.confirmEdd) };
}

// S4-A7C synthetic-only contract. No deployed Follow-Up RPC is represented here.
export function assertFollowUpMockContext(context, ids, { completed = false } = {}) {
  if (context?.contract !== "S4-A7C-mock-follow-up-v1") fail("Only the isolated Follow-Up context is supported.");
  // Reuse the exact UUID/status shape checks after validating this distinct mock envelope.
  const state = assertInitialContext({ ...context, contract: "S4-A7A-v1" }, ids, { completed });
  const baseline = context.initial_record;
  if (baseline?.patient_id !== ids.patientId || baseline?.doctor_id !== ids.doctorId ||
    baseline?.form_data?.visitFormType !== "initial" || baseline?.form_data?.recordStatus !== "completed" ||
    !uuidPattern.test(baseline.id || "") || baseline.schedule_id !== context.initial_appointment_id || !uuidPattern.test(baseline.schedule_id || "") || baseline.schedule_id === ids.appointmentId ||
    state.context?.patient_id !== ids.patientId) fail("An exact saved Initial consultation and distinct Follow-Up appointment are required.");
  if (completed && state.record?.form_data?.visitFormType !== "follow_up") fail("Expected an authoritative Follow-Up record.");
  for (const kind of ["obstetric", "medical"]) {
    const id = state.context[`${kind}_id`];
    if (id && !state[kind].some((row) => row.id === id && row.patient_id === ids.patientId)) fail("Applicable history linkage is unresolved or inconsistent.");
  }
  return state;
}
export function buildFollowUpMockRequest(context, form, ids) {
  const state = assertFollowUpMockContext(context, ids), encounter = validateInitialEncounter(form);
  const canonicalEdd = state.patient.expected_delivery_date || null;
  if ((encounter.expectedDeliveryDate || null) !== canonicalEdd) fail("Follow-Up mock EDD is read-only; dating reconciliation remains blocked.", "expectedDeliveryDate");
  return { contract: "S4-A7C-mock-follow-up-v1", patient_id: ids.patientId,
    initial_record_id: context.initial_record.id, expected: cloneClinical(state), encounter,
    history: { obstetric_id: state.context.obstetric_id, medical_id: state.context.medical_id, pregnancy_id: state.context.pregnancy_id } };
}
