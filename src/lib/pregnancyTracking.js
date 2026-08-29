const millisecondsPerWeek = 604800000;

function parseNumber(value) {
  if (value === null || value === undefined) return null;

  const match = String(value).trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function getTimestamp(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
}

function getNowTimestamp(now) {
  if (now instanceof Date) return now.getTime();
  return Number.isFinite(now) ? now : Date.now();
}

export function parsePregnancyWeek(value) {
  const weeks = parseNumber(value);
  if (weeks === null || weeks < 0 || weeks > 42) return null;
  return Math.round(weeks);
}

export function calculateWeeksFromLmp(value, now = Date.now()) {
  const lmpTimestamp = getTimestamp(value);
  if (lmpTimestamp === null) return null;

  const weeks = Math.floor((getNowTimestamp(now) - lmpTimestamp) / millisecondsPerWeek);
  return weeks >= 0 && weeks <= 42 ? weeks : null;
}

export function calculateWeeksFromEdd(value, now = Date.now()) {
  const eddTimestamp = getTimestamp(value);
  if (eddTimestamp === null) return null;

  const weeks = 40 - Math.floor((eddTimestamp - getNowTimestamp(now)) / millisecondsPerWeek);
  return weeks >= 0 && weeks <= 42 ? weeks : null;
}

export function resolvePregnancyWeek({
  expectedDeliveryDate,
  lastMenstrualPeriod,
  clinicalGestationalAge,
  storedGestationalAge,
  now = Date.now(),
}) {
  return (
    calculateWeeksFromEdd(expectedDeliveryDate, now) ??
    calculateWeeksFromLmp(lastMenstrualPeriod, now) ??
    parsePregnancyWeek(clinicalGestationalAge) ??
    parsePregnancyWeek(storedGestationalAge)
  );
}

export function getPregnancyTrimester(week) {
  if (week === null || week === undefined) return null;
  if (week <= 12) return { number: 1, label: "1st Trimester" };
  if (week <= 27) return { number: 2, label: "2nd Trimester" };
  return { number: 3, label: "3rd Trimester" };
}

export function resolvePregnancyTracking({
  patient = {},
  obstetric = {},
  clinicalGestationalAge = "",
  now = Date.now(),
}) {
  const expectedDeliveryDate =
    obstetric?.expected_delivery_date || patient?.expected_delivery_date || "";
  const week = resolvePregnancyWeek({
    expectedDeliveryDate,
    lastMenstrualPeriod: obstetric?.last_menstrual_period,
    clinicalGestationalAge,
    storedGestationalAge: patient?.gestational_age,
    now,
  });
  const gravida = parseNumber(obstetric?.gravida);
  const para = parseNumber(obstetric?.para);

  return {
    week,
    trimester: getPregnancyTrimester(week),
    weeksRemaining: week === null ? null : Math.max(0, 40 - week),
    progressPercent:
      week === null ? null : Math.round(Math.min(100, (week / 40) * 100)),
    expectedDeliveryDate,
    pregnancyNumber:
      gravida !== null || para !== null ? `G${gravida ?? 0}P${para ?? 0}` : "",
    hasCurrentPregnancy: week !== null,
  };
}
