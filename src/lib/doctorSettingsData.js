export const doctorSettingsFields = {
  personal: {
    displayName: "full_name", birthdate: "birthdate", civilStatus: "civil_status",
    gender: "gender", nationality: "nationality", yearsExperience: "years_of_experience",
  },
  professional: {
    doctorId: "doctor_code", boardCertification: "board_certification",
    licenseNumber: "license_number", email: "email_address", clinicName: "clinic_hospital_name",
    contactNumber: "contact_number", clinicAddress: "clinic_address",
  },
  account: { email: "email_address", contactNumber: "contact_number" },
  email: { email: "email_address" },
};

const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const normalizeEmail = value => String(value ?? "").trim().toLowerCase();

export function parseDoctorExperience(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  // Existing saved values are displayed as "N Years". Accept that exact
  // representation, without extracting digits from arbitrary text.
  const match = text.match(/^(\d+)(?:\s+years?)?$/i);
  const years = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(years) || years < 0 || years > 2147483647) {
    throw new Error("Enter a nonnegative whole number, or leave blank.");
  }
  return years;
}

export function parseDoctorCalendarDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let year, month, day;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const named = text.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (named) {
    const index = months.findIndex(name => name === named[1].toLowerCase() || name.slice(0, 3) === named[1].toLowerCase());
    year = Number(named[3]); month = index + 1; day = Number(named[2]);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (!year || year > 9999 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Enter a valid calendar date, such as 2003-01-31.");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function prepareDoctorSettingsDraft(section, draft, email) {
  const fields = doctorSettingsFields[section];
  if (!fields) throw new Error("Unknown Doctor settings section.");
  const payload = {}, errors = {};
  for (const [field, value] of Object.entries(draft)) {
    if (!Object.hasOwn(fields, field)) throw new Error("A field does not belong to this settings section.");
    try {
      if (field === "birthdate") payload[fields[field]] = parseDoctorCalendarDate(value);
      else if (field === "yearsExperience") payload[fields[field]] = parseDoctorExperience(value);
      else if (field === "email") {
        if (normalizeEmail(value) !== normalizeEmail(email)) throw new Error("Use Change Email to update your login email.");
        payload.email_address = normalizeEmail(email);
      } else payload[fields[field]] = String(value ?? "").trim() || null;
    } catch (error) { errors[field] = error.message; }
  }
  return { payload, errors };
}

export function validateDoctorSettingsDraft(section, draft, email) {
  const result = prepareDoctorSettingsDraft(section, draft, email);
  if (Object.keys(result.errors).length) {
    throw Object.assign(new Error("Check the highlighted fields."), {
      code: "doctor_settings_validation", fieldErrors: result.errors, section,
    });
  }
  return result.payload;
}

// Each section writes only its submitted fields. Shared name/contact/email
// synchronization is required when those fields change; it is never best-effort.
export async function saveDoctorSettingsSection(scope, loadDoctor, section, draft) {
  const user = await scope.getUser();
  let identity = await loadDoctor(user);
  await scope.check();
  if (identity.authUser?.id !== scope.userId) throw new Error("The Doctor identity could not be verified.");
  const payload = validateDoctorSettingsDraft(section, draft, user.email);
  const personal = section === "personal";
  const table = personal ? "doctor_personal_information" : "doctor_professional_information";
  const completedSteps = [];
  let stage = "information save";
  const step = async (label, action) => {
    stage = label;
    await scope.check();
    const result = await action();
    await scope.check();
    if (result.error) throw result.error;
    completedSteps.push(label);
    return result.data;
  };
  try {
    if (!Object.keys(payload).length) return { identity, completedSteps };
    const row = await step("information save", () => {
      const query = scope.client.from(table);
      // A missing personal row otherwise defaults unknown experience to zero.
      // Insert instead of upserting defaults: a concurrent insert must be retried
      // against fresh canonical data, rather than overwrite its saved fields.
      const write = personal && !identity.personalInformation
        ? query.insert({ auth_user_id: user.id, years_of_experience: null, ...payload })
        : query.upsert({ auth_user_id: user.id, ...payload }, { onConflict: "auth_user_id" });
      return write.select("*").single();
    });
    if (row?.auth_user_id !== user.id) throw new Error("The saved information could not be read back.");
    identity = { ...identity, [personal ? "personalInformation" : "professionalInformation"]: row };
    const shared = {};
    if (personal && "full_name" in payload) shared.full_name = row.full_name;
    if (!personal && "contact_number" in payload) shared.contact_number = row.contact_number;
    if (Object.keys(shared).length) {
      const profile = await step("shared profile synchronization", () => scope.client.from("profiles")
        .update(shared).eq("id", user.id).select("id, full_name, contact_number").single());
      if (profile?.id !== user.id) throw new Error("The shared profile update could not be confirmed.");
      identity = { ...identity, profile: { ...identity.profile, ...profile } };
    }
    if ("email_address" in payload) {
      const email = await step("email synchronization", () => scope.client.rpc("sync_current_profile_email"));
      if (normalizeEmail(email) !== normalizeEmail(user.email)) throw new Error("The saved email could not be confirmed.");
      identity = { ...identity, profile: { ...identity.profile, email } };
    }
    await scope.check();
    return { identity, completedSteps };
  } catch (error) {
    if (error.code === "mutation_cancelled") throw error;
    throw Object.assign(new Error(completedSteps.length
      ? `Some changes were saved, but ${stage} could not be confirmed. Retry this section to finish saving.`
      : "The save could not be confirmed. Please retry."), {
      code: completedSteps.length ? "doctor_settings_partial_save" : "doctor_settings_save_error",
      cause: error, completedSteps, canonicalIdentity: completedSteps.length ? identity : null, section,
    });
  }
}
