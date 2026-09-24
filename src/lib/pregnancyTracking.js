const daysPerWeek = 7;

function parseNumber(value) {
  if (value === null || value === undefined) return null;

  const match = String(value).trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function getCalendarDay(value) {
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
  );
}

function getTodayCalendarDay(now) {
  return getCalendarDay(now instanceof Date ? now : new Date(Number.isFinite(now) ? now : Date.now()));
}

export function parsePregnancyWeek(value) {
  const weeks = parseNumber(value);
  if (weeks === null || weeks < 0 || weeks > 42) return null;
  return Math.round(weeks);
}

export function calculateWeeksFromLmp(value, now = Date.now()) {
  const lmpDay = getCalendarDay(value);
  const todayDay = getTodayCalendarDay(now);
  if (lmpDay === null || todayDay === null) return null;

  const weeks = Math.floor((todayDay - lmpDay) / daysPerWeek);
  return weeks >= 0 && weeks <= 42 ? weeks : null;
}

export function calculateWeeksFromEdd(value, now = Date.now()) {
  const eddDay = getCalendarDay(value);
  const todayDay = getTodayCalendarDay(now);
  if (eddDay === null || todayDay === null) return null;

  const weeks = 40 - Math.floor((eddDay - todayDay) / daysPerWeek);
  return weeks >= 0 && weeks <= 42 ? weeks : null;
}

export function calculateCurrentPregnancyWeekFromEdd(value, now = Date.now()) {
  const week = calculateWeeksFromEdd(value, now);
  return week !== null && week >= 0 && week <= 40 ? week : null;
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

export function resolveCurrentPregnancyWeek({
  expectedDeliveryDate,
  lastMenstrualPeriod,
  clinicalGestationalAge,
  storedGestationalAge,
  now = Date.now(),
}) {
  if (String(expectedDeliveryDate || "").trim()) {
    return calculateCurrentPregnancyWeekFromEdd(expectedDeliveryDate, now);
  }

  return resolvePregnancyWeek({
    expectedDeliveryDate: "",
    lastMenstrualPeriod,
    clinicalGestationalAge,
    storedGestationalAge,
    now,
  });
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
