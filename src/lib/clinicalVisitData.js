const emptyClinicalValues = new Set([
  "",
  "-",
  "not provided",
  "not recorded",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
]);

const truthyFlags = new Set(["true", "1", "yes"]);

function getSourceData(source) {
  const value = source?.form_data ?? source;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function getFirstValue(...values) {
  return values.find((value) => isMeaningfulClinicalValue(value)) ?? "";
}

function normalizeLabel(value) {
  return String(value || "").trim().toLowerCase().replace(/[_\s/-]+/g, "");
}

function getFinding(data, labels) {
  const normalizedLabels = labels.map(normalizeLabel);
  const findings = Array.isArray(data.findings) ? data.findings : [];

  for (const item of findings) {
    const label = normalizeLabel(Array.isArray(item) ? item[0] : item?.label || item?.name);
    if (!normalizedLabels.includes(label)) continue;

    const value = Array.isArray(item) ? item[1] : item?.value ?? item?.result;
    if (isMeaningfulClinicalValue(value)) return value;
  }

  return "";
}

export function isMeaningfulClinicalValue(value) {
  if (value === null || value === undefined || typeof value === "object") return false;
  return !emptyClinicalValues.has(String(value).trim().toLowerCase());
}

export function normalizeRiskLevel(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (["low", "low risk"].includes(normalized)) return "Low Risk";
  if (["moderate", "moderate risk"].includes(normalized)) return "Moderate Risk";
  if (["high", "high risk"].includes(normalized)) return "High Risk";
  return isMeaningfulClinicalValue(value) ? String(value).trim() : "";
}

export function normalizeClinicalVisitFormData(source) {
  const data = getSourceData(source);
  const clinicalFindings =
    (data.clinicalFindings && typeof data.clinicalFindings === "object"
      ? data.clinicalFindings
      : data.clinical_findings) || {};
  const pregnancyDetails =
    (data.pregnancyStatus && typeof data.pregnancyStatus === "object"
      ? data.pregnancyStatus
      : data.pregnancy_status && typeof data.pregnancy_status === "object"
        ? data.pregnancy_status
        : {}) || {};
  const legacyRisk =
    typeof data.pregnancyStatus !== "object"
      ? data.pregnancyStatus
      : typeof data.pregnancy_status !== "object"
        ? data.pregnancy_status
        : "";

  return {
    ...data,
    gestationalAge: getFirstValue(
      data.gestationalAge,
      data.gestational_age,
      pregnancyDetails.gestationalAge,
      pregnancyDetails.gestational_age
    ),
    expectedDeliveryDate: getFirstValue(
      data.expectedDeliveryDate,
      data.expected_delivery_date,
      pregnancyDetails.expectedDeliveryDate,
      pregnancyDetails.expected_delivery_date
    ),
    riskLevel: normalizeRiskLevel(
      getFirstValue(
        data.riskLevel,
        data.risk_level,
        pregnancyDetails.riskLevel,
        pregnancyDetails.risk_level,
        legacyRisk
      )
    ),
    fetalHeartRate: getFirstValue(
      data.fetalHeartRate,
      data.fetal_heart_rate,
      clinicalFindings.fetalHeartRate,
      clinicalFindings.fetal_heart_rate,
      data.heartRate,
      getFinding(data, ["Fetal Heart Rate"])
    ),
    fundalHeight: getFirstValue(
      data.fundalHeight,
      data.fundal_height,
      clinicalFindings.fundalHeight,
      clinicalFindings.fundal_height,
      getFinding(data, ["Fundal Height"])
    ),
    babyPosition: getFirstValue(
      data.babyPosition,
      data.baby_position,
      data.fetalPosition,
      data.fetal_position,
      data.presentation,
      clinicalFindings.babyPosition,
      clinicalFindings.baby_position,
      clinicalFindings.fetalPosition,
      clinicalFindings.fetal_position,
      getFinding(data, ["Baby Position", "Fetal Position", "Presentation"])
    ),
    fetalMovement: getFirstValue(
      data.fetalMovement,
      data.fetal_movement,
      data.movement,
      clinicalFindings.fetalMovement,
      clinicalFindings.fetal_movement,
      clinicalFindings.movement,
      getFinding(data, ["Fetal Movement", "Movement"])
    ),
  };
}

export function buildCanonicalClinicalVisitFormData(source) {
  const canonical = { ...normalizeClinicalVisitFormData(source) };

  [
    "pregnancyStatus",
    "pregnancy_status",
    "risk_level",
    "baby_position",
    "fetalPosition",
    "fetal_position",
    "presentation",
  ].forEach((legacyKey) => delete canonical[legacyKey]);

  return canonical;
}

export function isCompletedClinicalVisitRecord(record) {
  const data = getSourceData(record);
  const status = String(data.recordStatus || data.record_status || "completed")
    .trim()
    .toLowerCase();
  const isDraft = truthyFlags.has(String(data.isDraft || data.is_draft || "false").trim().toLowerCase());
  const isDeleted = truthyFlags.has(String(data.deleted || "false").trim().toLowerCase());

  return status === "completed" && !isDraft && !isDeleted;
}

export function getLatestCompletedClinicalValue(records, field) {
  for (const record of records) {
    if (!isCompletedClinicalVisitRecord(record)) continue;

    const value = normalizeClinicalVisitFormData(record)[field];
    if (isMeaningfulClinicalValue(value)) return { record, value };
  }

  return { record: null, value: "" };
}
