import { supabase } from "./supabaseClient";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const POLICY_TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function getSinglePolicyRow(data) {
  if (Array.isArray(data)) {
    if (data.length !== 1) {
      throw new Error("The operational appointment policy is missing or duplicated.");
    }

    return data[0];
  }

  if (data && typeof data === "object") {
    return data;
  }

  throw new Error("The operational appointment policy was not returned.");
}

function parsePolicyTime(value, label) {
  const normalized = String(value || "").trim();
  const match = POLICY_TIME_PATTERN.exec(normalized);

  if (!match) {
    throw new Error(`The operational appointment policy has an invalid ${label}.`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);

  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`The operational appointment policy has an invalid ${label}.`);
  }

  return { normalized, secondsSinceMidnight: hours * 3600 + minutes * 60 + seconds };
}

function createTimeZoneFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`The appointment timezone "${timeZone}" is invalid or unsupported.`);
  }
}

function getFormattedDateTimeParts(formatter, value) {
  const values = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function dateTimePartsToUtcMilliseconds(parts) {
  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return value.getTime();
}

function dateTimePartsMatch(first, second) {
  return (
    first.year === second.year &&
    first.month === second.month &&
    first.day === second.day &&
    first.hour === second.hour &&
    first.minute === second.minute &&
    first.second === second.second
  );
}

export async function loadOperationalAppointmentPolicy() {
  const { data, error } = await supabase.rpc("get_operational_appointment_policy");

  if (error) {
    throw new Error(
      `Unable to load the operational appointment policy: ${error.message || "Unknown error."}`
    );
  }

  const row = getSinglePolicyRow(data);
  const timezone = String(row.timezone || "").trim();
  const openingTime = parsePolicyTime(row.clinic_opening_time, "clinic opening time");
  const closingTime = parsePolicyTime(row.clinic_closing_time, "clinic closing time");
  const defaultAppointmentDurationMinutes = Number(
    row.default_appointment_duration_minutes
  );
  const updatedAt = String(row.updated_at || "").trim();

  if (!timezone) {
    throw new Error("The operational appointment policy has no timezone.");
  }

  createTimeZoneFormatter(timezone);

  if (closingTime.secondsSinceMidnight <= openingTime.secondsSinceMidnight) {
    throw new Error("The operational appointment policy has invalid clinic hours.");
  }

  if (
    !Number.isInteger(defaultAppointmentDurationMinutes) ||
    defaultAppointmentDurationMinutes <= 0
  ) {
    throw new Error(
      "The operational appointment policy has an invalid default appointment duration."
    );
  }

  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("The operational appointment policy has an invalid update timestamp.");
  }

  return {
    timezone,
    clinicOpeningTime: openingTime.normalized,
    clinicClosingTime: closingTime.normalized,
    defaultAppointmentDurationMinutes,
    updatedAt,
  };
}

export function clinicLocalDateTimeToISOString(dateValue, timeValue, timeZone) {
  const dateMatch = DATE_PATTERN.exec(String(dateValue || "").trim());
  const timeMatch = TIME_PATTERN.exec(String(timeValue || "").trim());
  const normalizedTimeZone = String(timeZone || "").trim();

  if (!dateMatch) {
    throw new Error("Choose a valid appointment date in YYYY-MM-DD format.");
  }

  if (!timeMatch) {
    throw new Error("Choose a valid appointment time in HH:mm format.");
  }

  if (!normalizedTimeZone) {
    throw new Error("The appointment timezone is required.");
  }

  const targetParts = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
    second: 0,
  };

  if (
    targetParts.month < 1 ||
    targetParts.month > 12 ||
    targetParts.day < 1 ||
    targetParts.day > 31 ||
    targetParts.hour > 23 ||
    targetParts.minute > 59
  ) {
    throw new Error("Choose a valid clinic appointment date and time.");
  }

  const targetUtcMilliseconds = dateTimePartsToUtcMilliseconds(targetParts);
  const normalizedTarget = getFormattedDateTimeParts(
    createTimeZoneFormatter("UTC"),
    new Date(targetUtcMilliseconds)
  );

  if (!dateTimePartsMatch(normalizedTarget, targetParts)) {
    throw new Error("Choose a valid clinic appointment date and time.");
  }

  const formatter = createTimeZoneFormatter(normalizedTimeZone);
  let candidateMilliseconds = targetUtcMilliseconds;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observedParts = getFormattedDateTimeParts(
      formatter,
      new Date(candidateMilliseconds)
    );
    const correction =
      targetUtcMilliseconds - dateTimePartsToUtcMilliseconds(observedParts);

    candidateMilliseconds += correction;

    if (correction === 0) break;
  }

  const candidate = new Date(candidateMilliseconds);
  const roundTripParts = getFormattedDateTimeParts(formatter, candidate);

  if (!dateTimePartsMatch(roundTripParts, targetParts)) {
    throw new Error(
      `The selected clinic date and time is invalid in the ${normalizedTimeZone} timezone.`
    );
  }

  return candidate.toISOString();
}
