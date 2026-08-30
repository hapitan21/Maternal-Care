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

function getObjectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getPreferredFieldValue(data, keys, ...fallbacks) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) return data[key] ?? "";
  }
  return getFirstValue(...fallbacks);
}

function normalizeClinicalAttachment(value) {
  const attachment = getObjectValue(value);
  const name = getFirstValue(attachment.name, attachment.fileName);
  const path = getFirstValue(attachment.path, attachment.storagePath);
  const dataUrl = getFirstValue(
    attachment.dataUrl,
    attachment.url,
    attachment.publicUrl
  );

  if (!name || (!path && !dataUrl)) return null;

  const normalized = {
    name,
    type: getFirstValue(attachment.type, attachment.fileType) || "application/pdf",
    size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : 0,
  };

  if (path) normalized.path = path;
  if (dataUrl) normalized.dataUrl = dataUrl;
  return normalized;
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
  const laboratoryReviewSource = getObjectValue(
    data.laboratoryReview || data.laboratory_review
  );
  const ultrasoundReviewSource = getObjectValue(
    data.ultrasoundReview || data.ultrasound_review
  );
  const laboratoryAttachment = normalizeClinicalAttachment(
    data.laboratoryAttachment ||
      data.laboratory_attachment ||
      laboratoryReviewSource.attachment
  );
  const ultrasoundAttachment = normalizeClinicalAttachment(
    data.ultrasoundAttachment ||
      data.ultrasound_attachment ||
      ultrasoundReviewSource.attachment
  );
  const laboratoryTestType = getPreferredFieldValue(
    data,
    ["laboratoryTestType", "laboratory_test_type"],
    laboratoryReviewSource.testType,
    laboratoryReviewSource.test_type
  );
  const laboratoryResultSummary = getPreferredFieldValue(
    data,
    ["laboratoryResultSummary", "laboratory_result_summary"],
    laboratoryReviewSource.resultSummary,
    laboratoryReviewSource.result_summary,
    typeof data.laboratoryReview === "string" ? data.laboratoryReview : ""
  );
  const laboratoryInterpretation = getPreferredFieldValue(
    data,
    ["laboratoryInterpretation", "laboratory_interpretation"],
    laboratoryReviewSource.interpretation
  );
  const laboratoryReportAttached = getPreferredFieldValue(
    data,
    ["laboratoryReportAttached", "laboratory_report_attached"],
    laboratoryReviewSource.reportAttached,
    laboratoryReviewSource.report_attached
  );
  const ultrasoundVisitDate = getPreferredFieldValue(
    data,
    ["ultrasoundVisitDate", "ultrasound_visit_date"],
    ultrasoundReviewSource.visitDate,
    ultrasoundReviewSource.visit_date
  );
  const ultrasoundFindings = getPreferredFieldValue(
    data,
    ["ultrasoundFindings", "ultrasound_findings"],
    ultrasoundReviewSource.findings,
    typeof data.ultrasoundReview === "string" ? data.ultrasoundReview : ""
  );
  const ultrasoundReportAttached = getPreferredFieldValue(
    data,
    ["ultrasoundReportAttached", "ultrasound_report_attached"],
    ultrasoundReviewSource.reportAttached,
    ultrasoundReviewSource.report_attached
  );

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
    laboratoryTestType,
    laboratoryResultSummary,
    laboratoryInterpretation,
    laboratoryReportAttached,
    laboratoryAttachment,
    laboratoryReview: {
      ...laboratoryReviewSource,
      testType: laboratoryTestType,
      resultSummary: laboratoryResultSummary,
      interpretation: laboratoryInterpretation,
      reportAttached: laboratoryReportAttached,
      attachment: laboratoryAttachment,
    },
    ultrasoundVisitDate,
    ultrasoundFindings,
    ultrasoundReportAttached,
    ultrasoundAttachment,
    ultrasoundReview: {
      ...ultrasoundReviewSource,
      visitDate: ultrasoundVisitDate,
      findings: ultrasoundFindings,
      reportAttached: ultrasoundReportAttached,
      attachment: ultrasoundAttachment,
    },
  };
}

export function buildCanonicalClinicalVisitFormData(source) {
  const canonical = { ...normalizeClinicalVisitFormData(source) };

  const laboratoryAttachment = canonical.laboratoryReportAttached === "No"
    ? null
    : canonical.laboratoryAttachment;
  const ultrasoundAttachment = canonical.ultrasoundReportAttached === "No"
    ? null
    : canonical.ultrasoundAttachment;

  canonical.laboratoryAttachment = laboratoryAttachment;
  canonical.laboratoryReview = {
    ...getObjectValue(canonical.laboratoryReview),
    testType: canonical.laboratoryTestType,
    resultSummary: canonical.laboratoryResultSummary,
    interpretation: canonical.laboratoryInterpretation,
    reportAttached: canonical.laboratoryReportAttached,
    attachment: laboratoryAttachment,
  };
  canonical.ultrasoundAttachment = ultrasoundAttachment;
  canonical.ultrasoundReview = {
    ...getObjectValue(canonical.ultrasoundReview),
    visitDate: canonical.ultrasoundVisitDate,
    findings: canonical.ultrasoundFindings,
    reportAttached: canonical.ultrasoundReportAttached,
    attachment: ultrasoundAttachment,
  };

  [
    "pregnancyStatus",
    "pregnancy_status",
    "risk_level",
    "baby_position",
    "fetalPosition",
    "fetal_position",
    "presentation",
    "laboratory_review",
    "laboratory_attachment",
    "ultrasound_review",
    "ultrasound_attachment",
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
