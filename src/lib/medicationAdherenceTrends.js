import {
  addManilaCalendarDays,
  normalizeMedicationAdherenceStatus,
} from "./medicationAdherence.js";
import {
  APPOINTMENT_TIME_ZONE,
  formatAppointmentDate,
  getManilaDateKey,
} from "./appointmentDate.js";

const completedStatuses = new Set(["taken", "skipped", "missed"]);

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export function createInclusiveManilaDateSequence(startDate, endDate) {
  if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) {
    return [];
  }

  const dates = [];
  let current = startDate;
  while (current && current <= endDate) {
    if (dates.length === 367) return [];
    dates.push(current);
    current = addManilaCalendarDays(current, 1);
  }
  return dates;
}

export function getPreviousMedicationAdherenceRange(currentStart, currentEnd) {
  const currentDates = createInclusiveManilaDateSequence(currentStart, currentEnd);
  if (!currentDates.length) {
    return {
      currentStart,
      currentEnd,
      previousStart: "",
      previousEnd: "",
      dayCount: 0,
    };
  }

  const previousEnd = addManilaCalendarDays(currentStart, -1);
  const previousStart = addManilaCalendarDays(
    previousEnd,
    -(currentDates.length - 1)
  );

  return {
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
    dayCount: currentDates.length,
  };
}

function createDailyEntry(dateKey) {
  const dateValue = `${dateKey}T00:00:00+08:00`;
  return {
    dateKey,
    dateLabel: formatAppointmentDate(dateValue),
    shortLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: APPOINTMENT_TIME_ZONE,
      month: "short",
      day: "numeric",
    }).format(new Date(dateValue)),
    taken: 0,
    skipped: 0,
    missed: 0,
    completedOutcomes: 0,
    adherenceRate: null,
  };
}

function aggregateRange(occurrences, startDate, endDate) {
  const dates = createInclusiveManilaDateSequence(startDate, endDate);
  const dailyByDate = new Map(
    dates.map((dateKey) => [dateKey, createDailyEntry(dateKey)])
  );

  occurrences.forEach((occurrence) => {
    const dateKey = getManilaDateKey(occurrence.scheduled_for);
    if (!dailyByDate.has(dateKey)) return;

    const status = normalizeMedicationAdherenceStatus(occurrence.status);
    if (!completedStatuses.has(status)) return;
    dailyByDate.get(dateKey)[status] += 1;
  });

  const daily = dates.map((dateKey) => {
    const entry = dailyByDate.get(dateKey);
    const completedOutcomes = entry.taken + entry.skipped + entry.missed;
    return {
      ...entry,
      completedOutcomes,
      adherenceRate: completedOutcomes
        ? Math.round((entry.taken / completedOutcomes) * 100)
        : null,
    };
  });

  const totals = daily.reduce(
    (summary, day) => ({
      taken: summary.taken + day.taken,
      skipped: summary.skipped + day.skipped,
      missed: summary.missed + day.missed,
      completedOutcomes: summary.completedOutcomes + day.completedOutcomes,
    }),
    { taken: 0, skipped: 0, missed: 0, completedOutcomes: 0 }
  );

  return {
    daily,
    summary: {
      ...totals,
      adherenceRate: totals.completedOutcomes
        ? Math.round((totals.taken / totals.completedOutcomes) * 100)
        : null,
    },
  };
}

export function buildMedicationAdherenceTrendData({
  occurrences,
  currentStart,
  currentEnd,
  previousStart,
  previousEnd,
}) {
  const seenIds = new Set();
  const validOccurrences = [];

  (Array.isArray(occurrences) ? occurrences : []).forEach((occurrence) => {
    const id = String(occurrence?.id || "").trim();
    const status = normalizeMedicationAdherenceStatus(occurrence?.status);
    if (!id || seenIds.has(id) || !completedStatuses.has(status)) return;
    if (!getManilaDateKey(occurrence?.scheduled_for)) return;

    seenIds.add(id);
    validOccurrences.push({ ...occurrence, status });
  });

  const current = aggregateRange(validOccurrences, currentStart, currentEnd);
  const previous = aggregateRange(validOccurrences, previousStart, previousEnd);
  const currentRate = current.summary.adherenceRate;
  const previousRate = previous.summary.adherenceRate;
  const changePercentagePoints =
    currentRate === null || previousRate === null
      ? null
      : currentRate - previousRate;

  let interpretation = "No previous-period data available";
  if (changePercentagePoints > 0) {
    interpretation = "Improved from the previous period";
  } else if (changePercentagePoints < 0) {
    interpretation = "Lower than the previous period";
  } else if (changePercentagePoints === 0) {
    interpretation = "No change from the previous period";
  }

  return {
    dailyCurrent: current.daily,
    dailyPrevious: previous.daily,
    currentSummary: current.summary,
    previousSummary: previous.summary,
    comparison: {
      changePercentagePoints,
      interpretation,
      isLimitedData:
        current.summary.completedOutcomes < 3 ||
        previous.summary.completedOutcomes < 3,
    },
  };
}
