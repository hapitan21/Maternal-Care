import React from "react";
import { useNavigate } from "react-router-dom";
import PasswordSecurityFeedback from "../../components/common/PasswordSecurityFeedback";
import "../../styles/doctor-settings.css";
import "../../styles/staff-settings.css";
import { supabase } from "../../lib/supabaseClient";
import {
  getPasswordValidationMessage,
  PASSWORD_MIN_LENGTH,
  passwordsMatch,
  validatePassword,
} from "../../lib/passwordSecurity";
import {
  cacheStaffSettings,
  getStaffSettings,
  saveStaffSettings,
} from "../../lib/staffProfile";
import { isValidPhilippineMobileNumber } from "../../lib/philippinePhone";

function StaffIcon({ name }) {
  const icons = {
    profile: (
      <>
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </>
    ),
    account: (
      <>
        <circle cx="9" cy="8.5" r="3" />
        <path d="M4 19a5 5 0 0 1 10 0" />
        <path d="M16.5 11.5v5M14 14h5" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    pencil: (
      <>
        <path d="M4.5 19.5 8 18.8 18.6 8.2a2.1 2.1 0 0 0-3-3L5 15.8l-.5 3.7Z" />
        <path d="m14.2 6.6 3.2 3.2" />
      </>
    ),
    close: (
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6 6 18" />
      </>
    ),
    mail: (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
        <path d="m4.5 7 7.5 6 7.5-6" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3.5 19 6v5.2c0 4.4-2.8 8.2-7 9.3-4.2-1.1-7-4.9-7-9.3V6l7-2.5Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    key: (
      <>
        <circle cx="8.5" cy="12" r="3.5" />
        <path d="M12 12h8M17 12v-2M20 12v3" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 11.5V16" />
        <path d="M12 8h.01" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </>
    ),
    eye: (
      <>
        <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    eyeOff: (
      <>
        <path d="M3 3 21 21" />
        <path d="M10.7 5.2A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a15 15 0 0 1-3 3.8" />
        <path d="M6.6 6.9A15 15 0 0 0 2.5 12s3.5 7 9.5 7a10 10 0 0 0 4.2-.9" />
      </>
    ),
  };

  return (
    <svg
      className="doctor-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name]}
    </svg>
  );
}

const sections = [
  { id: "profile", label: "Profile", icon: "profile" },
  { id: "account", label: "Account", icon: "account" },
  { id: "security", label: "Password & Security", icon: "lock" },
];

const EMPTY_STAFF_SETTINGS = {
  displayName: "",
  birthdate: "",
  civilStatus: "",
  gender: "",
  nationality: "",
  address: "",
  employeeId: "",
  position: "",
  dateHired: "",
  employmentStatus: "",
  email: "",
  clinicName: "",
  contactNumber: "",
  clinicAddress: "",
  twoFactorAuth: false,
  loginNotifications: false,
};

const staffPersonalSelect = `
  full_name,
  birthdate,
  civil_status,
  gender,
  nationality,
  address
`;
const staffPersonalLegacySelect = `
  full_name,
  birthdate,
  civil_status,
  gender,
  nationality
`;
const staffProfessionalSelect = `
  staff_code,
  position,
  date_hired,
  employment_status,
  email_address,
  contact_number,
  clinic_hospital_name,
  clinic_address
`;
const staffProfessionalLegacySelect = `
  staff_code,
  email_address,
  contact_number,
  clinic_hospital_name,
  clinic_address
`;

// This component is named StaffSettingsContent, but the SQL supplied by the
// project uses doctor_account_settings. Keep this value consistent with the
// exact Supabase table name.
const ACCOUNT_SETTINGS_TABLE = "staff_account_settings";
const OTP_COOLDOWN_SECONDS = 60;
const AUTH_REQUEST_TIMEOUT_MS = 45000;
const EMAIL_CHANGE_SEND_FALLBACK_MS = 6000;
const CHANGE_EMAIL_INITIAL_STATE = {
  isOpen: false,
  step: "details",
  currentPassword: "",
  currentEmail: "",
  newEmail: "",
  currentEmailOtp: "",
  newEmailOtp: "",
  pendingEmail: "",
  isLoading: false,
  error: "",
  success: "",
  currentEmailVerified: false,
  newEmailVerified: false,
  currentOtpSentAt: null,
  newOtpSentAt: null,
  currentOtpCooldown: 0,
  newOtpCooldown: 0,
};
const CHANGE_PASSWORD_INITIAL_STATE = {
  isOpen: false,
  step: "otp",
  currentEmail: "",
  otp: "",
  pendingNewPassword: "",
  isLoading: false,
  loadingLabel: "",
  error: "",
  success: "",
  otpCooldown: 0,
};

function InfoItem({ label, value, editing, onChange }) {
  return (
    <label className="doctor-settings-info-item">
      <span>{label}</span>

      {editing ? (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <strong>{value || "Not provided"}</strong>
      )}
    </label>
  );
}

function nullableText(value) {
  const cleanedValue = String(value ?? "").trim();
  return cleanedValue || null;
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());
}

function normalizeOtp(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}

function withAuthTimeout(promise, label) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          `${label} is taking longer than expected. Please try again.`
        )
      );
    }, AUTH_REQUEST_TIMEOUT_MS);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function sendEmailChangeWithFallback(newEmail) {
  let timeoutId;

  const updatePromise = supabase.auth.updateUser({
    email: newEmail,
  });

  const fallbackPromise = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => {
      resolve({
        data: null,
        error: null,
        didFallback: true,
      });
    }, EMAIL_CHANGE_SEND_FALLBACK_MS);
  });

  return Promise.race([updatePromise, fallbackPromise]).finally(() => {
    window.clearTimeout(timeoutId);
    updatePromise.catch((error) => {
      console.warn("Late email-change response failed:", error);
    });
  });
}

function getFriendlyAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = error?.status;

  if (message.includes("invalid login credentials")) {
    return "The current password is incorrect.";
  }

  if (
    message.includes("already registered") ||
    message.includes("already been registered") ||
    message.includes("user already registered") ||
    message.includes("email address already")
  ) {
    return "That email is already used by another account.";
  }

  if (
    message.includes("invalid") &&
    (message.includes("email") || message.includes("otp") || message.includes("token"))
  ) {
    return "The OTP is invalid or expired. Click Send OTP again and use the newest code for this exact email change.";
  }

  if (
    message.includes("expired") ||
    message.includes("token has expired")
  ) {
    return "The OTP has expired. Click Send OTP again and use the newest code.";
  }

  if (
    status === 429 ||
    message.includes("rate limit") ||
    message.includes("too many") ||
    message.includes("over_request_rate_limit")
  ) {
    return "Too many attempts. Please wait before trying again.";
  }

  return error?.message || "The request could not be completed.";
}

function getStaffSettingsFallback() {
  const cachedSettings = getStaffSettings();

  return {
    ...EMPTY_STAFF_SETTINGS,
    ...cachedSettings,
    twoFactorAuth: Boolean(cachedSettings.twoFactorAuth),
    loginNotifications: Boolean(
      cachedSettings.loginNotifications
    ),
  };
}

function isSchemaColumnError(error) {
  if (!error) return false;
  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    message.includes("column")
  );
}

function formatDateTime(value) {
  if (!value) {
    return "Not available";
  }

  const dateValue = new Date(value);

  if (Number.isNaN(dateValue.getTime())) {
    return "Not available";
  }

  return dateValue.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isMissingAccountSettingsTableError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    error?.code === "42P01" ||
    message.includes(ACCOUNT_SETTINGS_TABLE) ||
    message.includes("schema cache")
  );
}

function getDefaultAccountSettingsRecord(user) {
  return {
    id: null,
    user_id: user?.id || null,
    email_address: user?.email?.trim().toLowerCase() || null,
    contact_number: null,
    two_factor_auth: false,
    login_notifications: false,
    created_at: null,
    updated_at: null,
    isFallback: true,
  };
}

async function getAuthenticatedUser() {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    throw error;
  }

  if (!user) {
    throw new Error(
      "No active Supabase login was found. Please log in again."
    );
  }

  return user;
}

async function saveAccountSettingsRecord(payload) {
  const { data, error } = await supabase
    .from(ACCOUNT_SETTINGS_TABLE)
    .upsert(payload, {
      onConflict: "user_id",
    })
    .select(
      "id, user_id, email_address, contact_number, two_factor_auth, login_notifications, created_at, updated_at"
    )
    .single();

  if (error) {
    if (isMissingAccountSettingsTableError(error)) {
      console.warn(
        `${ACCOUNT_SETTINGS_TABLE} is not available; continuing with staff profile tables only.`
      );

      return {
        id: null,
        created_at: null,
        updated_at: null,
        isFallback: true,
        ...payload,
      };
    }

    throw error;
  }

  return data;
}

async function loadOrCreateAccountSettingsRecord(user) {
  const { data, error } = await supabase
    .from(ACCOUNT_SETTINGS_TABLE)
    .select(
      "id, user_id, email_address, contact_number, two_factor_auth, login_notifications, created_at, updated_at"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    if (isMissingAccountSettingsTableError(error)) {
      console.warn(
        `${ACCOUNT_SETTINGS_TABLE} is not available; using default account settings.`
      );

      return getDefaultAccountSettingsRecord(user);
    }

    throw error;
  }

  if (data) {
    return data;
  }

  // Create the user's first settings row automatically so it immediately
  // appears in the Supabase table when the Settings page is opened.
  return saveAccountSettingsRecord({
    user_id: user.id,
    email_address: user.email?.trim().toLowerCase() || null,
    contact_number: null,
    two_factor_auth: false,
    login_notifications: false,
  });
}

async function saveStaffTableRecord(tableName, payload) {
  const existingResult = await supabase
    .from(tableName)
    .select("auth_user_id")
    .eq("auth_user_id", payload.auth_user_id)
    .limit(1)
    .maybeSingle();

  if (existingResult.error) {
    throw existingResult.error;
  }

  const query = existingResult.data?.auth_user_id
    ? supabase
        .from(tableName)
        .update(payload)
        .eq("auth_user_id", payload.auth_user_id)
    : supabase.from(tableName).insert([payload]);

  const { data, error } = await query.select("auth_user_id");

  if (error) {
    throw error;
  }

  return Array.isArray(data) ? data[0] : data;
}

async function loadStaffTableRecord(tableName, selectColumns, fallbackColumns, userId) {
  let { data, error } = await supabase
    .from(tableName)
    .select(selectColumns)
    .eq("auth_user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error && isSchemaColumnError(error) && fallbackColumns) {
    const fallbackResult = await supabase
      .from(tableName)
      .select(fallbackColumns)
      .eq("auth_user_id", userId)
      .limit(1)
      .maybeSingle();
    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  return { data, error };
}

async function saveStaffTableRecordWithSchemaFallback(
  tableName,
  payload,
  fallbackPayload
) {
  try {
    return await saveStaffTableRecord(tableName, payload);
  } catch (error) {
    if (!isSchemaColumnError(error) || !fallbackPayload) {
      throw error;
    }

    console.warn(
      `${tableName} is missing one or more optional Staff profile columns; saved only the currently available columns.`
    );
    return saveStaffTableRecord(tableName, fallbackPayload);
  }
}

async function syncConfirmedStaffEmail(userId, email, settingsSnapshot) {
  const confirmedEmail = normalizeEmail(email);

  if (!userId || !confirmedEmail) {
    throw new Error(
      "The confirmed staff email could not be synchronized."
    );
  }

  await saveAccountSettingsRecord({
    user_id: userId,
    email_address: confirmedEmail,
    contact_number: nullableText(
      settingsSnapshot.contactNumber
    ),
    two_factor_auth: Boolean(
      settingsSnapshot.twoFactorAuth
    ),
    login_notifications: Boolean(
      settingsSnapshot.loginNotifications
    ),
  });

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ email: confirmedEmail })
    .eq("id", userId);

  if (profileError) {
    throw profileError;
  }

  const currentTimestamp = new Date().toISOString();
  const professionalPayload = {
    auth_user_id: userId,
    staff_code: nullableText(settingsSnapshot.employeeId),
    position: nullableText(settingsSnapshot.position),
    date_hired: nullableText(settingsSnapshot.dateHired),
    employment_status: nullableText(settingsSnapshot.employmentStatus),
    email_address: confirmedEmail,
    contact_number: nullableText(settingsSnapshot.contactNumber),
    clinic_hospital_name: nullableText(settingsSnapshot.clinicName),
    clinic_address: nullableText(settingsSnapshot.clinicAddress),
    updated_at: currentTimestamp,
  };

  await saveStaffTableRecordWithSchemaFallback(
    "staff_professional_information",
    professionalPayload,
    {
      auth_user_id: userId,
      staff_code: nullableText(settingsSnapshot.employeeId),
      email_address: confirmedEmail,
      contact_number: nullableText(settingsSnapshot.contactNumber),
      clinic_hospital_name: nullableText(settingsSnapshot.clinicName),
      clinic_address: nullableText(settingsSnapshot.clinicAddress),
      updated_at: currentTimestamp,
    }
  );
}

let cachedStaffSettingsView = null;

let cachedStaffAuthenticatedUser = null;

function getInitialStaffSettingsSnapshot() {
  const sharedSnapshot = getStaffSettingsFallback();

  const sharedEmail = normalizeEmail(
    sharedSnapshot.email
  );

  const cachedEmail = normalizeEmail(
    cachedStaffSettingsView?.email
  );

  if (
    cachedStaffSettingsView &&
    sharedEmail &&
    cachedEmail === sharedEmail
  ) {
    return {
      ...cachedStaffSettingsView,
    };
  }

  if (
    cachedStaffSettingsView &&
    (!sharedEmail || cachedEmail !== sharedEmail)
  ) {
    cachedStaffSettingsView = null;
    cachedStaffAuthenticatedUser = null;
  }

  return sharedSnapshot;
}

function hasSettingsSnapshot(settings) {
  return Boolean(
    settings?.displayName ||
      settings?.email ||
      settings?.employeeId ||
      settings?.contactNumber
  );
}

function StaffSettingsContent({ headerAction }) {
  const navigate = useNavigate();
  const [activePanel, setActivePanel] = React.useState("profile");

  const initialSettingsSnapshot =
    getInitialStaffSettingsSnapshot();

  const [authenticatedUser, setAuthenticatedUser] =
    React.useState(() => {
      const cachedUserEmail = normalizeEmail(
        cachedStaffAuthenticatedUser?.email
      );

      const snapshotEmail = normalizeEmail(
        initialSettingsSnapshot.email
      );

      return cachedUserEmail &&
        snapshotEmail &&
        cachedUserEmail === snapshotEmail
        ? cachedStaffAuthenticatedUser
        : null;
    });

  const [settings, setSettings] = React.useState(
    initialSettingsSnapshot
  );

  const [draftSettings, setDraftSettings] = React.useState(
    initialSettingsSnapshot
  );

  const [editing, setEditing] = React.useState({
    personal: false,
    professional: false,
  });

  const [passwordForm, setPasswordForm] = React.useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });

  const [passwordVisible, setPasswordVisible] = React.useState({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
  });
  const [confirmPasswordInteracted, setConfirmPasswordInteracted] =
    React.useState(false);

  const [isLoadingSettings, setIsLoadingSettings] =
    React.useState(
      !hasSettingsSnapshot(initialSettingsSnapshot)
    );

  const [isSavingSettings, setIsSavingSettings] =
    React.useState(false);

  const [settingsMessage, setSettingsMessage] =
    React.useState("");

  const [settingsError, setSettingsError] =
    React.useState("");

  const passwordResult = validatePassword(passwordForm.newPassword);
  const passwordMatch = passwordsMatch(
    passwordForm.newPassword,
    passwordForm.confirmPassword
  );
  const passwordFormValid =
    Boolean(passwordForm.currentPassword) &&
    passwordResult.valid &&
    passwordMatch;

  const [changeEmail, setChangeEmail] =
    React.useState(CHANGE_EMAIL_INITIAL_STATE);

  const [changePasswordOtp, setChangePasswordOtp] =
    React.useState(CHANGE_PASSWORD_INITIAL_STATE);

  const setChangeEmailField = (field, value) => {
    setChangeEmail((current) => ({
      ...current,
      [field]: value,
      error: "",
      success: "",
    }));
  };

  const setChangePasswordOtpField = (field, value) => {
    setChangePasswordOtp((current) => ({
      ...current,
      [field]: value,
      error: "",
      success: "",
    }));
  };

  React.useEffect(() => {
    let isMounted = true;

    async function loadSettingsFromSupabase() {
      /*
       * Keep the last successful snapshot visible while Supabase refreshes.
       * A blocking loading state is only needed when we have no useful Staff
       * data yet.
       */
      if (!cachedStaffSettingsView) {
        const sharedSnapshot =
          getInitialStaffSettingsSnapshot();

        if (hasSettingsSnapshot(sharedSnapshot)) {
          setSettings(sharedSnapshot);
          setDraftSettings(sharedSnapshot);
          setIsLoadingSettings(false);
        } else {
          setIsLoadingSettings(true);
        }
      }

      setSettingsError("");
      setSettingsMessage("");

      try {
        const user = await getAuthenticatedUser();

        cachedStaffAuthenticatedUser = user;

        if (isMounted) {
          setAuthenticatedUser(user);
        }

        // Load/create the account row first. This prevents an error from an
        // unrelated profile table from stopping Account data from appearing.
        const account = await loadOrCreateAccountSettingsRecord(user);

        const [personalResult, professionalResult] =
          await Promise.all([
            loadStaffTableRecord(
              "staff_personal_information",
              staffPersonalSelect,
              staffPersonalLegacySelect,
              user.id
            ),
            loadStaffTableRecord(
              "staff_professional_information",
              staffProfessionalSelect,
              staffProfessionalLegacySelect,
              user.id
            ),
          ]);

        // Account settings still load even if one of these optional profile
        // tables is not ready yet. Their errors are reported separately.
        const profileErrors = [
          personalResult.error,
          professionalResult.error,
        ].filter(Boolean);

        profileErrors.forEach((error) => {
          console.warn("Optional staff profile table load failed:", error);
        });

        const personal = personalResult.error
          ? null
          : personalResult.data;
        const professional = professionalResult.error
          ? null
          : professionalResult.data;

        const fallbackSettings = getStaffSettingsFallback();

        const loadedSettings = {
          ...fallbackSettings,

          displayName:
            personal?.full_name ??
            fallbackSettings.displayName,
          birthdate:
            personal?.birthdate ??
            fallbackSettings.birthdate,
          civilStatus:
            personal?.civil_status ??
            fallbackSettings.civilStatus,
          gender:
            personal?.gender ??
            fallbackSettings.gender,
          nationality:
            personal?.nationality ??
            fallbackSettings.nationality,

          address:
            personal?.address ??
            fallbackSettings.address,

          employeeId:
            professional?.staff_code ??
            fallbackSettings.employeeId,
          position:
            professional?.position ??
            fallbackSettings.position,
          dateHired:
            professional?.date_hired ??
            fallbackSettings.dateHired,
          employmentStatus:
            professional?.employment_status ??
            fallbackSettings.employmentStatus,

          email:
            user.email ??
            account?.email_address ??
            professional?.email_address ??
            fallbackSettings.email,

          clinicName:
            professional?.clinic_hospital_name ??
            fallbackSettings.clinicName,

          contactNumber:
            account?.contact_number ??
            professional?.contact_number ??
            fallbackSettings.contactNumber,

          clinicAddress:
            professional?.clinic_address ??
            fallbackSettings.clinicAddress,

          twoFactorAuth:
            account?.two_factor_auth ??
            fallbackSettings.twoFactorAuth,

          loginNotifications:
            account?.login_notifications ??
            fallbackSettings.loginNotifications,
        };

        cachedStaffSettingsView = {
          ...loadedSettings,
        };

        cacheStaffSettings(loadedSettings, {
          broadcast: false,
        });

        if (isMounted) {
          setSettings(loadedSettings);
          setDraftSettings(loadedSettings);

          if (profileErrors.length > 0) {
            setSettingsError(
              "Account settings loaded, but one or more staff profile tables could not be loaded. Check their SQL tables and RLS policies."
            );
          }
        }
      } catch (error) {
        console.error(
          "Staff settings Supabase load failed:",
          error
        );

        if (isMounted) {
          setSettingsError(
            error?.message ||
              "Account settings could not be loaded from Supabase."
          );
        }
      } finally {
        if (isMounted) {
          setIsLoadingSettings(false);
        }
      }
    }

    loadSettingsFromSupabase();

    return () => {
      isMounted = false;
    };
  }, []);

  React.useEffect(() => {
    if (!changeEmail.isOpen) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setChangeEmail((current) => ({
        ...current,
        currentOtpCooldown: Math.max(
          0,
          current.currentOtpCooldown - 1
        ),
        newOtpCooldown: Math.max(
          0,
          current.newOtpCooldown - 1
        ),
      }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [changeEmail.isOpen]);

  React.useEffect(() => {
    if (!changePasswordOtp.isOpen) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setChangePasswordOtp((current) => ({
        ...current,
        otpCooldown: Math.max(0, current.otpCooldown - 1),
      }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [changePasswordOtp.isOpen]);

  React.useEffect(() => {
    if (
      typeof document === "undefined" ||
      (!changeEmail.isOpen && !changePasswordOtp.isOpen)
    ) {
      return undefined;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [changeEmail.isOpen, changePasswordOtp.isOpen]);

  const redirectToLoginAfterEmailChange = React.useCallback(() => {
    window.setTimeout(async () => {
      try {
        await withAuthTimeout(supabase.auth.signOut(), "Sign out");
      } catch (error) {
        console.error("Sign out after email change failed:", error);
      } finally {
        navigate("/login?emailChanged=1", { replace: true });
      }
    }, 300);
  }, [navigate]);

  const redirectToLoginAfterPasswordChange = React.useCallback(() => {
    window.setTimeout(async () => {
      try {
        await withAuthTimeout(supabase.auth.signOut(), "Sign out");
      } catch (error) {
        console.error("Sign out after password change failed:", error);
      } finally {
        navigate("/login?logout=1", { replace: true });
      }
    }, 1200);
  }, [navigate]);

  React.useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event !== "USER_UPDATED") {
          return;
        }

        const confirmedEmail = normalizeEmail(
          session?.user?.email
        );

        if (!confirmedEmail) {
          return;
        }

        setAuthenticatedUser(session.user);

        const pendingEmail = normalizeEmail(changeEmail.pendingEmail);

        if (
          !changeEmail.isOpen ||
          !pendingEmail ||
          pendingEmail !== confirmedEmail
        ) {
          return;
        }

        setChangeEmail((current) => ({
          ...current,
          step: "complete",
          isLoading: false,
          error: "",
          success: "Email changed successfully.",
          currentEmailVerified: true,
          newEmailVerified: true,
        }));

        const nextSettings = {
          ...draftSettings,
          email: confirmedEmail,
        };

        window.setTimeout(async () => {
          try {
            await syncConfirmedStaffEmail(
              session.user.id,
              confirmedEmail,
              nextSettings
            );

            cachedStaffSettingsView = {
              ...nextSettings,
            };

            setSettings(nextSettings);
            setDraftSettings(nextSettings);
            saveStaffSettings(nextSettings);

            setSettingsMessage(
              "Email changed successfully. Please log in again."
            );
            redirectToLoginAfterEmailChange();
          } catch (error) {
            console.error(
              "Confirmed email sync failed:",
              error
            );

            setSettingsError(
              error?.message ||
                "The login email changed, but one or more Supabase profile tables could not be synchronized."
            );
          }
        }, 0);
      }
    );

    return () => data.subscription.unsubscribe();
  }, [
    changeEmail.isOpen,
    changeEmail.pendingEmail,
    draftSettings,
    redirectToLoginAfterEmailChange,
  ]);

  const updateSetting = (field, value) => {
    setDraftSettings((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const clearMessages = () => {
    setSettingsMessage("");
    setSettingsError("");
  };

  const saveProfileSettingsToSupabase = async (
    nextSettings
  ) => {
    if (
      nextSettings.contactNumber &&
      !isValidPhilippineMobileNumber(nextSettings.contactNumber)
    ) {
      throw new Error("Enter a valid Philippine mobile number.");
    }

    const user = await getAuthenticatedUser();

    const currentTimestamp = new Date().toISOString();

    const personalPayload = {
      auth_user_id: user.id,
      full_name: nullableText(nextSettings.displayName),
      birthdate: nullableText(nextSettings.birthdate),
      civil_status: nullableText(nextSettings.civilStatus),
      gender: nullableText(nextSettings.gender),
      nationality: nullableText(nextSettings.nationality),
      address: nullableText(nextSettings.address),
      updated_at: currentTimestamp,
    };

    await saveStaffTableRecordWithSchemaFallback(
      "staff_personal_information",
      personalPayload,
      {
        auth_user_id: user.id,
        full_name: nullableText(nextSettings.displayName),
        birthdate: nullableText(nextSettings.birthdate),
        civil_status: nullableText(nextSettings.civilStatus),
        gender: nullableText(nextSettings.gender),
        nationality: nullableText(nextSettings.nationality),
        updated_at: currentTimestamp,
      }
    );

    const professionalPayload = {
      auth_user_id: user.id,
      staff_code: nullableText(nextSettings.employeeId),
      position: nullableText(nextSettings.position),
      date_hired: nullableText(nextSettings.dateHired),
      employment_status: nullableText(nextSettings.employmentStatus),
      email_address: nullableText(nextSettings.email) || user.email || null,
      contact_number: nullableText(nextSettings.contactNumber),
      clinic_hospital_name: nullableText(nextSettings.clinicName),
      clinic_address: nullableText(nextSettings.clinicAddress),
      updated_at: currentTimestamp,
    };

    await saveStaffTableRecordWithSchemaFallback(
      "staff_professional_information",
      professionalPayload,
      {
        auth_user_id: user.id,
        staff_code: nullableText(nextSettings.employeeId),
        email_address: nullableText(nextSettings.email) || user.email || null,
        contact_number: nullableText(nextSettings.contactNumber),
        clinic_hospital_name: nullableText(nextSettings.clinicName),
        clinic_address: nullableText(nextSettings.clinicAddress),
        updated_at: currentTimestamp,
      }
    );

    // Keep the Account tab and staff_account_settings table synchronized
    // when email/contact values are changed from Professional Information.
    await saveAccountSettingsRecord({
      user_id: user.id,
      email_address: normalizeEmail(user.email) || null,
      contact_number: nullableText(
        nextSettings.contactNumber
      ),
      two_factor_auth: Boolean(
        nextSettings.twoFactorAuth
      ),
      login_notifications: Boolean(
        nextSettings.loginNotifications
      ),
    });
  };

  const persistProfileSettings = async (
    nextSettings = draftSettings
  ) => {
    setIsSavingSettings(true);
    clearMessages();

    try {
      await saveProfileSettingsToSupabase(nextSettings);

      cachedStaffSettingsView = {
        ...nextSettings,
      };

      setSettings(nextSettings);
      setDraftSettings(nextSettings);
      saveStaffSettings(nextSettings);

      setSettingsMessage(
        "Staff information was saved to Supabase."
      );
    } catch (error) {
      console.error(
        "Staff settings Supabase save failed:",
        error
      );

      setSettingsError(
        error?.message ||
          "Staff information could not be saved to Supabase."
      );

      throw error;
    } finally {
      setIsSavingSettings(false);
    }
  };

  const saveProfileSettings = async (event) => {
    event?.preventDefault();

    try {
      await persistProfileSettings(draftSettings);

      setEditing({
        personal: false,
        professional: false,
      });
    } catch {
      // The error is already displayed on the page.
    }
  };

  const toggleProfileEdit = (section) => {
    clearMessages();

    if (editing[section]) {
      // Cancel editing and restore the most recently saved values.
      setDraftSettings(settings);

      setEditing((current) => ({
        ...current,
        [section]: false,
      }));

      return;
    }

    // Start from the latest saved values and edit only one section at a time.
    setDraftSettings(settings);

    setEditing({
      personal: section === "personal",
      professional: section === "professional",
    });
  };

  const saveAccountSettings = async (event) => {
    event?.preventDefault();

    setIsSavingSettings(true);
    clearMessages();

    try {
      const user = await getAuthenticatedUser();

      const contactNumber = String(
        draftSettings.contactNumber ?? ""
      ).trim();

      if (
        contactNumber &&
        !isValidPhilippineMobileNumber(contactNumber)
      ) {
        throw new Error("Enter a valid Philippine mobile number.");
      }

      await saveAccountSettingsRecord({
        user_id: user.id,
        email_address: normalizeEmail(user.email) || null,
        contact_number: contactNumber || null,
        two_factor_auth: Boolean(
          draftSettings.twoFactorAuth
        ),
        login_notifications: Boolean(
          draftSettings.loginNotifications
        ),
      });

      const nextSettings = {
        ...draftSettings,
        email: normalizeEmail(user.email),
        contactNumber,
      };

      cachedStaffSettingsView = {
        ...nextSettings,
      };

      setSettings(nextSettings);
      setDraftSettings(nextSettings);
      saveStaffSettings(nextSettings);

      setSettingsMessage("Contact number saved successfully.");
    } catch (error) {
      console.error(
        "Account settings Supabase save failed:",
        error
      );

      setSettingsError(
        error?.message ||
          "Account settings could not be saved to Supabase."
      );
    } finally {
      setIsSavingSettings(false);
    }
  };

  const openChangeEmailModal = () => {
    clearMessages();
    setChangeEmail({
      ...CHANGE_EMAIL_INITIAL_STATE,
      isOpen: true,
      newEmail: "",
    });
  };

  const closeChangeEmailModal = () => {
    if (changeEmail.isLoading) {
      return;
    }

    setChangeEmail(CHANGE_EMAIL_INITIAL_STATE);
  };

  const requestEmailChangeOtp = async (event) => {
    event?.preventDefault();

    setChangeEmail((current) => ({
      ...current,
      step: "details",
      isLoading: true,
      error: "",
      success: "",
      currentEmailOtp: "",
      newEmailOtp: "",
      currentEmailVerified: false,
      newEmailVerified: false,
    }));

    try {
      const user = await getAuthenticatedUser();
      const currentEmail = normalizeEmail(user.email);
      const newEmail = normalizeEmail(changeEmail.newEmail);

      if (!currentEmail) {
        throw new Error(
          "The current staff account does not have a login email."
        );
      }

      if (!changeEmail.currentPassword) {
        throw new Error("Enter your current password.");
      }

      if (!isValidEmail(newEmail)) {
        throw new Error("Enter a valid new email address.");
      }

      if (newEmail === currentEmail) {
        throw new Error(
          "The new email is the same as your current login email."
        );
      }

      const { error: verifyPasswordError } = await withAuthTimeout(
        supabase.auth.signInWithPassword({
          email: currentEmail,
          password: changeEmail.currentPassword,
        }),
        "Password verification"
      );

      if (verifyPasswordError) {
        throw verifyPasswordError;
      }

      const { error: updateEmailError, didFallback } =
        await sendEmailChangeWithFallback(newEmail);

      if (updateEmailError) {
        throw updateEmailError;
      }

      setChangeEmail((current) => ({
        ...current,
        step: "currentOtp",
        currentEmail,
        pendingEmail: newEmail,
        currentPassword: "",
        isLoading: false,
        error: "",
        success:
          didFallback
            ? "OTP request sent. Check the 6-digit code sent to your current email first."
            : "OTP sent. Check the 6-digit code sent to your current email first.",
        currentOtpSentAt: Date.now(),
        newOtpSentAt: Date.now(),
        currentOtpCooldown: OTP_COOLDOWN_SECONDS,
        newOtpCooldown: OTP_COOLDOWN_SECONDS,
      }));
    } catch (error) {
      console.error("Email change request failed:", error);

      setChangeEmail((current) => ({
        ...current,
        step: "details",
        isLoading: false,
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const verifyEmailChangeOtp = async (target) => {
    const isCurrentEmailStep = target === "current";
    const pendingEmail = normalizeEmail(changeEmail.pendingEmail);
    const token = normalizeOtp(
      isCurrentEmailStep
        ? changeEmail.currentEmailOtp
        : changeEmail.newEmailOtp
    );

    if (!token) {
      setChangeEmail((current) => ({
        ...current,
        error: "Enter the OTP code first.",
        success: "",
      }));
      return;
    }

    if (isCurrentEmailStep) {
      setChangeEmail((current) => ({
        ...current,
        step: "newOtp",
        isLoading: false,
        currentEmailVerified: true,
        currentEmailOtp: "",
        error: "",
        success:
          "Current email code accepted. Now enter the 6-digit code sent to the new email.",
      }));
      return;
    }

    setChangeEmail((current) => ({
      ...current,
      isLoading: true,
      error: "",
      success: "",
    }));

    try {
      if (!pendingEmail) {
        throw new Error(
          "The new email was not found. Please start the email change again."
        );
      }

      const { data: verifyData, error: verifyError } =
        await withAuthTimeout(
          supabase.auth.verifyOtp({
            email: pendingEmail,
            token,
            type: "email_change",
          }),
          "New email OTP verification"
        );

      if (verifyError) {
        throw verifyError;
      }

      const confirmedUser =
        verifyData?.user || verifyData?.session?.user || null;
      const confirmedEmail = pendingEmail;

      if (confirmedUser) {
        setAuthenticatedUser(confirmedUser);
      }

      const nextSettings = {
        ...draftSettings,
        email: confirmedEmail,
      };

      const userForSync =
        confirmedUser || authenticatedUser || (await getAuthenticatedUser());

      setSettings(nextSettings);
      setDraftSettings(nextSettings);
      setSettingsMessage(
        "Email changed successfully. Please log in again."
      );

      setChangeEmail((current) => ({
        ...current,
        step: "complete",
        isLoading: false,
        error: "",
        success: "Email changed successfully.",
        newEmailVerified: true,
        newEmailOtp: "",
      }));

      redirectToLoginAfterEmailChange();

      syncConfirmedStaffEmail(
        userForSync.id,
        confirmedEmail,
        nextSettings
      ).catch((error) => {
        console.error("Confirmed email sync failed:", error);
      });
    } catch (error) {
      console.error("Email change OTP verification failed:", error);

      setChangeEmail((current) => ({
        ...current,
        isLoading: false,
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const resendEmailChangeOtp = async (target) => {
    const isCurrentEmailStep = target === "current";
    const cooldownField = isCurrentEmailStep
      ? "currentOtpCooldown"
      : "newOtpCooldown";
    const email = isCurrentEmailStep
      ? normalizeEmail(authenticatedUser?.email)
      : normalizeEmail(changeEmail.pendingEmail);

    if (changeEmail[cooldownField] > 0) {
      return;
    }

    setChangeEmail((current) => ({
      ...current,
      isLoading: true,
      error: "",
      success: "",
    }));

    try {
      const { error } = await withAuthTimeout(
        supabase.auth.resend({
          type: "email_change",
          email,
        }),
        "Resending OTP"
      );

      if (error) {
        throw error;
      }

      setChangeEmail((current) => ({
        ...current,
        isLoading: false,
        error: "",
        success: `OTP resent to ${
          isCurrentEmailStep ? "current email" : "new email"
        }.`,
        [isCurrentEmailStep
          ? "currentOtpSentAt"
          : "newOtpSentAt"]: Date.now(),
        [cooldownField]: OTP_COOLDOWN_SECONDS,
      }));
    } catch (error) {
      console.error("Email change OTP resend failed:", error);

      setChangeEmail((current) => ({
        ...current,
        isLoading: false,
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const closeChangePasswordOtpModal = () => {
    if (changePasswordOtp.isLoading) {
      return;
    }

    setChangePasswordOtp(CHANGE_PASSWORD_INITIAL_STATE);
  };

  const changePassword = async (event) => {
    event.preventDefault();

    setIsSavingSettings(true);
    clearMessages();

    try {
      const user = await getAuthenticatedUser();
      const currentPassword =
        passwordForm.currentPassword;
      const newPassword = passwordForm.newPassword;

      if (!currentPassword) {
        throw new Error("Enter your current password.");
      }

      if (!user.email) {
        throw new Error(
          "The current account does not have an email address."
        );
      }

      if (!newPassword) {
        throw new Error("Enter a new password.");
      }

      if (!passwordResult.valid) {
        throw new Error(getPasswordValidationMessage(newPassword));
      }

      if (!passwordMatch) {
        throw new Error(
          "The new password and confirmation do not match."
        );
      }

      const { error: verifyPasswordError } =
        await supabase.auth.signInWithPassword({
          email: user.email,
          password: currentPassword,
        });

      if (verifyPasswordError) {
        throw new Error(
          "The current password is incorrect."
        );
      }

      const passwordRedirectTo =
        typeof window === "undefined"
          ? undefined
          : new URL("/staff/settings", window.location.origin).toString();

      const { error: otpError } = await withAuthTimeout(
        supabase.auth.resetPasswordForEmail(user.email, {
          redirectTo: passwordRedirectTo,
        }),
        "Password OTP request"
      );

      if (otpError) {
        throw otpError;
      }

      setChangePasswordOtp({
        ...CHANGE_PASSWORD_INITIAL_STATE,
        isOpen: true,
        currentEmail: normalizeEmail(user.email),
        pendingNewPassword: newPassword,
        success:
          "OTP sent to your current email. Enter the 6-digit code to finish changing your password.",
        otpCooldown: OTP_COOLDOWN_SECONDS,
      });
    } catch (error) {
      console.error(
        "Supabase password change request failed:",
        error
      );

      setSettingsError(
        getFriendlyAuthError(error) ||
          "Your password change could not be started."
      );
    } finally {
      setIsSavingSettings(false);
    }
  };

  const resendPasswordChangeOtp = async () => {
    if (changePasswordOtp.otpCooldown > 0) {
      return;
    }

    setChangePasswordOtp((current) => ({
      ...current,
      isLoading: true,
      loadingLabel: "Sending OTP...",
      error: "",
      success: "",
    }));

    try {
      const email =
        normalizeEmail(changePasswordOtp.currentEmail) ||
        normalizeEmail(authenticatedUser?.email);

      if (!email) {
        throw new Error(
          "The current account does not have an email address."
        );
      }

      const passwordRedirectTo =
        typeof window === "undefined"
          ? undefined
          : new URL("/staff/settings", window.location.origin).toString();

      const { error } = await withAuthTimeout(
        supabase.auth.resetPasswordForEmail(email, {
          redirectTo: passwordRedirectTo,
        }),
        "Password OTP resend"
      );

      if (error) {
        throw error;
      }

      setChangePasswordOtp((current) => ({
        ...current,
        isLoading: false,
        loadingLabel: "",
        error: "",
        success: "OTP resent to your current email.",
        otpCooldown: OTP_COOLDOWN_SECONDS,
      }));
    } catch (error) {
      console.error("Password OTP resend failed:", error);

      setChangePasswordOtp((current) => ({
        ...current,
        isLoading: false,
        loadingLabel: "",
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const verifyPasswordOtpAndUpdate = async () => {
    const token = normalizeOtp(changePasswordOtp.otp);
    const email =
      normalizeEmail(changePasswordOtp.currentEmail) ||
      normalizeEmail(authenticatedUser?.email);

    if (!token) {
      setChangePasswordOtp((current) => ({
        ...current,
        error: "Enter the OTP code first.",
        success: "",
      }));
      return;
    }

    setChangePasswordOtp((current) => ({
      ...current,
      isLoading: true,
      loadingLabel: "Verifying OTP...",
      error: "",
      success: "Verifying OTP...",
    }));

    try {
      if (!email) {
        throw new Error(
          "The current account does not have an email address."
        );
      }

      if (!validatePassword(changePasswordOtp.pendingNewPassword).valid) {
        throw new Error(
          getPasswordValidationMessage(changePasswordOtp.pendingNewPassword)
        );
      }

      const { error: verifyOtpError } = await withAuthTimeout(
        supabase.auth.verifyOtp({
          email,
          token,
          type: "recovery",
        }),
        "Password OTP verification"
      );

      if (verifyOtpError) {
        throw verifyOtpError;
      }

      setChangePasswordOtp((current) => ({
        ...current,
        loadingLabel: "Updating password...",
        success: "OTP verified. Updating your password...",
      }));

      const { error: updatePasswordError } =
        await withAuthTimeout(
          supabase.auth.updateUser({
            password: changePasswordOtp.pendingNewPassword,
          }),
          "Password update"
        );

      if (updatePasswordError) {
        throw updatePasswordError;
      }

      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setConfirmPasswordInteracted(false);

      setChangePasswordOtp((current) => ({
        ...current,
        step: "complete",
        otp: "",
        pendingNewPassword: "",
        isLoading: true,
        loadingLabel: "Signing out...",
        error: "",
        success:
          "Password updated successfully. Signing you out now.",
      }));

      setSettingsMessage(
        "Password updated successfully. Please log in again."
      );
      redirectToLoginAfterPasswordChange();
    } catch (error) {
      console.error("Password OTP verification failed:", error);

      setChangePasswordOtp((current) => ({
        ...current,
        isLoading: false,
        loadingLabel: "",
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const personalFields = [
    ["Full Name", "displayName"],
    ["Gender", "gender"],
    ["Birthdate", "birthdate"],
    ["Nationality", "nationality"],
    ["Civil Status", "civilStatus"],
    ["Address", "address"],
  ];

  const professionalFields = [
    ["Employee ID", "employeeId"],
    ["Position", "position"],
    ["Date Hired", "dateHired"],
    ["Employment Status", "employmentStatus"],
    ["Clinic/Hospital Name", "clinicName"],
    ["Clinic Address", "clinicAddress"],
    ["Contact Number", "contactNumber"],
    ["Email", "email"],
  ];

  const breadcrumbLabel =
    activePanel === "profile"
      ? "Profile"
      : activePanel === "account"
      ? "Account"
      : "Password & Security";

  return (
    <section
      className="doctor-settings-page staff-settings-page"
      data-panel={activePanel}
    >
      <header className="doctor-dashboard-header staff-section-header">
        <div>
          <h1>Settings</h1>

          <p className="doctor-settings-breadcrumb">
            Settings <span>{">"}</span>{" "}
            <b>{breadcrumbLabel}</b>
          </p>
        </div>

        {headerAction}
      </header>

      <div
        className="doctor-settings-shell"
        data-panel={activePanel}
      >
        <aside
          className="doctor-settings-sidebar"
          aria-label="Settings sections"
        >
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={
                activePanel === section.id
                  ? "is-active"
                  : ""
              }
              onClick={() => {
                setActivePanel(section.id);
                clearMessages();
              }}
            >
              <StaffIcon name={section.icon} />
              <span>{section.label}</span>
            </button>
          ))}
        </aside>

        <section className="doctor-settings-content">
          {activePanel === "profile" && (
            <form
              className="doctor-settings-profile-form"
              onSubmit={saveProfileSettings}
            >
              <header className="doctor-settings-section-header">
                <span>
                  <StaffIcon name="profile" />
                </span>

                <div>
                  <h2>Profile Settings</h2>
                  <p>
                    Manage your personal and professional
                    information.
                  </p>
                </div>
              </header>

              <div className="doctor-settings-info-stack">
                <section className="doctor-settings-info-card doctor-settings-info-card--personal">
                  <header>
                    <h3>Personal Information</h3>

                    <button
                      type="button"
                      onClick={() =>
                        toggleProfileEdit("personal")
                      }
                      disabled={
                        isLoadingSettings ||
                        isSavingSettings
                      }
                    >
                      <StaffIcon
                        name={editing.personal ? "close" : "pencil"}
                      />

                      <span>
                        {editing.personal ? "Cancel" : "Edit"}
                      </span>
                    </button>
                  </header>

                  <div
                    className={`doctor-settings-info-grid doctor-settings-info-grid--personal${
                      editing.personal
                        ? " is-editing"
                        : ""
                    }`}
                  >
                    {personalFields.map(
                      ([label, field]) => (
                        <InfoItem
                          key={field}
                          label={label}
                          value={
                            (editing.personal
                              ? draftSettings[field]
                              : settings[field]) || ""
                          }
                          editing={editing.personal}
                          onChange={(value) =>
                            updateSetting(field, value)
                          }
                        />
                      )
                    )}
                  </div>
                </section>

                <section className="doctor-settings-info-card doctor-settings-info-card--professional">
                  <header>
                    <h3>Professional Information</h3>

                    <button
                      type="button"
                      onClick={() =>
                        toggleProfileEdit(
                          "professional"
                        )
                      }
                      disabled={
                        isLoadingSettings ||
                        isSavingSettings
                      }
                    >
                      <StaffIcon
                        name={
                          editing.professional
                            ? "close"
                            : "pencil"
                        }
                      />

                      <span>
                        {editing.professional
                          ? "Cancel"
                          : "Edit"}
                      </span>
                    </button>
                  </header>

                  <div
                    className={`doctor-settings-info-grid doctor-settings-info-grid--professional${
                      editing.professional
                        ? " is-editing"
                        : ""
                    }`}
                  >
                    {professionalFields.map(
                      ([label, field]) => (
                        <InfoItem
                          key={field}
                          label={label}
                          value={
                            (editing.professional
                              ? draftSettings[field]
                              : settings[field]) || ""
                          }
                          editing={
                            editing.professional
                          }
                          onChange={(value) =>
                            updateSetting(field, value)
                          }
                        />
                      )
                    )}
                  </div>
                </section>
              </div>

              <div className="doctor-settings-footer">
                {settingsError && (
                  <p className="staff-patients-status-message">
                    {settingsError}
                  </p>
                )}

                {settingsMessage && (
                  <p className="staff-patients-status-message">
                    {settingsMessage}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={
                    isLoadingSettings ||
                    isSavingSettings
                  }
                >
                  {isLoadingSettings
                    ? "Loading..."
                    : isSavingSettings
                    ? "Saving..."
                    : "Save Changes"}
                </button>
              </div>
            </form>
          )}

          {activePanel === "account" && (
            <form
              className="doctor-settings-account-form"
              onSubmit={saveAccountSettings}
            >
              <header className="doctor-settings-section-header">
                <span>
                  <StaffIcon name="account" />
                </span>

                <div>
                  <h2>Account Settings</h2>
                  <p>
                    Manage your account details and
                    information.
                  </p>
                </div>
              </header>

              <section className="doctor-settings-account-block">
                <h3>Account Information</h3>

                <div className="doctor-settings-form-grid">
                  <label>
                    <span>Email Address</span>

                    <input
                      type="email"
                      autoComplete="email"
                      value={
                        authenticatedUser?.email ||
                        settings.email ||
                        ""
                      }
                      readOnly
                      disabled={isLoadingSettings}
                      aria-readonly="true"
                    />
                  </label>

                  <label>
                    <span>Contact Number</span>

                    <input
                      type="tel"
                      autoComplete="tel"
                      value={
                        draftSettings.contactNumber
                      }
                      onChange={(event) =>
                        updateSetting(
                          "contactNumber",
                          event.target.value
                        )
                      }
                      disabled={
                        isLoadingSettings ||
                        isSavingSettings
                      }
                    />
                  </label>
                </div>

                <div className="doctor-settings-inline-actions">
                  <button
                    type="submit"
                    disabled={
                      isLoadingSettings ||
                      isSavingSettings
                    }
                  >
                    {isLoadingSettings
                      ? "Loading..."
                      : isSavingSettings
                      ? "Saving..."
                      : "Save Changes"}
                  </button>

                  <button
                    type="button"
                    className="doctor-settings-secondary-action"
                    onClick={openChangeEmailModal}
                    disabled={
                      isLoadingSettings ||
                      isSavingSettings
                    }
                  >
                    Change Email
                  </button>
                </div>

                {settingsError && (
                  <p className="staff-patients-status-message">
                    {settingsError}
                  </p>
                )}

                {settingsMessage && (
                  <p className="staff-patients-status-message">
                    {settingsMessage}
                  </p>
                )}
              </section>

              <section className="doctor-settings-account-status">
                <header>
                  <span className="doctor-settings-status-logo">
                    <StaffIcon name="shield" />
                  </span>

                  <h3>Account Status</h3>
                </header>

                <div className="doctor-settings-status-list">
                  <article>
                    <span className="doctor-settings-status-icon">
                      <StaffIcon name="mail" />
                    </span>

                    <div>
                      <strong>
                        Email Verification
                      </strong>

                      <p>
                        {authenticatedUser?.email_confirmed_at
                          ? "Your login email is verified."
                          : "Your login email still needs verification."}
                      </p>
                    </div>

                    <mark>
                      {authenticatedUser?.email_confirmed_at
                        ? "Verified"
                        : "Pending"}
                    </mark>
                  </article>

                  <article>
                    <span className="doctor-settings-status-icon">
                      <StaffIcon name="profile" />
                    </span>

                    <div>
                      <strong>Account Status</strong>

                      <p>
                        Your account is active and in
                        good standing.
                      </p>
                    </div>

                    <mark>Active</mark>
                  </article>

                  <article>
                    <span className="doctor-settings-status-icon">
                      <StaffIcon name="clock" />
                    </span>

                    <div>
                      <strong>Last Login</strong>

                      <p>
                        {formatDateTime(
                          authenticatedUser?.last_sign_in_at
                        )}
                      </p>
                    </div>

                    <mark className="is-blue">
                      Active
                    </mark>
                  </article>
                </div>
              </section>
            </form>
          )}

          {activePanel === "security" && (
            <form
              className="doctor-settings-security-form"
              onSubmit={changePassword}
            >
              <header className="doctor-settings-section-header">
                <span>
                  <StaffIcon name="lock" />
                </span>

                <div>
                  <h2>Password & Security</h2>

                  <p>
                    Update your password and manage your
                    account securely.
                  </p>
                </div>
              </header>

              <div className="doctor-settings-security-grid">
                <section className="doctor-settings-security-card doctor-settings-password-card">
                  <h3>
                    <StaffIcon name="key" />
                    Change Password
                  </h3>

                  {[
                    [
                      "Current Password",
                      "currentPassword",
                      "Enter your current password",
                    ],
                    [
                      "New Password",
                      "newPassword",
                      "Enter new password",
                    ],
                    [
                      "Confirm New Password",
                      "confirmPassword",
                      "Confirm new password",
                    ],
                  ].map(
                    ([label, field, placeholder]) => (
                      <label
                        className="doctor-settings-password-field"
                        key={field}
                      >
                        <span>{label}</span>

                        <input
                          type={
                            passwordVisible[field]
                              ? "text"
                              : "password"
                          }
                          value={passwordForm[field]}
                          placeholder={placeholder}
                          onChange={(event) => {
                            if (field === "confirmPassword") {
                              setConfirmPasswordInteracted(true);
                            }
                            setPasswordForm(
                              (current) => ({
                                ...current,
                                [field]: event.target.value,
                              })
                            );
                          }}
                          onBlur={() => {
                            if (field === "confirmPassword") {
                              setConfirmPasswordInteracted(true);
                            }
                          }}
                          autoComplete={field === "currentPassword" ? "current-password" : "new-password"}
                          minLength={
                            field === "currentPassword"
                              ? undefined
                              : PASSWORD_MIN_LENGTH
                          }
                          required
                          disabled={
                            isSavingSettings ||
                            changePasswordOtp.isOpen
                          }
                        />

                        <button
                          type="button"
                          aria-label={`${passwordVisible[field] ? "Hide" : "Show"} ${label.toLowerCase()}`}
                          aria-pressed={passwordVisible[field]}
                          onClick={() =>
                            setPasswordVisible(
                              (current) => ({
                                ...current,
                                [field]:
                                  !current[field],
                              })
                            )
                          }
                        >
                          <StaffIcon
                            name={
                              passwordVisible[field]
                                ? "eye"
                                : "eyeOff"
                            }
                          />
                        </button>
                      </label>
                    )
                  )}

                  <PasswordSecurityFeedback
                    password={passwordForm.newPassword}
                    confirmPassword={passwordForm.confirmPassword}
                    confirmInteracted={confirmPasswordInteracted}
                  />

                  {settingsError && (
                    <p className="staff-patients-status-message">
                      {settingsError}
                    </p>
                  )}

                  {settingsMessage && (
                    <p className="staff-patients-status-message">
                      {settingsMessage}
                    </p>
                  )}

                  <button
                    className="doctor-settings-save-password"
                    type="submit"
                    disabled={
                      !passwordFormValid ||
                      isSavingSettings ||
                      changePasswordOtp.isOpen
                    }
                  >
                    {isSavingSettings
                      ? "Verifying..."
                      : "Save Changes"}
                  </button>
                </section>

                <section className="doctor-settings-security-card doctor-settings-options-card">
                  <h3>
                    <StaffIcon name="shield" />
                    Security Options
                  </h3>

                  <label className="doctor-settings-security-option">
                    <span>
                      <strong>
                        Two-Factor Authentication (2FA)
                      </strong>

                      <small>
                        MFA enrollment and sign-in challenge enforcement are not
                        available yet.
                      </small>
                    </span>

                    <span className="staff-security-unavailable">Unavailable</span>
                  </label>

                  <label className="doctor-settings-security-option">
                    <span>
                      <strong>
                        Login Notifications
                      </strong>

                      <small>
                        Login-event security emails are not available yet.
                      </small>
                    </span>

                    <span className="staff-security-unavailable">Unavailable</span>
                  </label>
                </section>
              </div>
            </form>
          )}
        </section>
      </div>

      {changeEmail.isOpen && (
        <div
          className="staff-email-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeChangeEmailModal();
            }
          }}
        >
          <section
            className="staff-email-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-change-email-title"
          >
            <header className="staff-email-modal-header">
              <div>
                <span className="staff-email-modal-icon">
                  <StaffIcon name="mail" />
                </span>

                <div>
                  <h2 id="staff-change-email-title">
                    Change Email
                  </h2>
                  <p>
                    Securely verify your password and both email
                    OTP codes.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="staff-email-modal-close"
                onClick={closeChangeEmailModal}
                disabled={changeEmail.isLoading}
                aria-label="Close change email modal"
              >
                x
              </button>
            </header>

            <div className="staff-email-steps" aria-hidden="true">
              {[
                ["details", "Password"],
                ["currentOtp", "Current OTP"],
                ["newOtp", "New OTP"],
              ].map(([step, label], index) => (
                <span
                  key={step}
                  className={
                    changeEmail.step === step ||
                    (changeEmail.step === "complete" && index < 3) ||
                    (step === "currentOtp" &&
                      changeEmail.currentEmailVerified) ||
                    (step === "newOtp" &&
                      changeEmail.newEmailVerified)
                      ? "is-active"
                      : ""
                  }
                >
                  {index + 1}
                  <small>{label}</small>
                </span>
              ))}
            </div>

            {changeEmail.error && (
              <p className="staff-email-modal-message is-error">
                {changeEmail.error}
              </p>
            )}

            {changeEmail.success && (
              <p className="staff-email-modal-message is-success">
                {changeEmail.success}
              </p>
            )}

            {changeEmail.step === "details" && (
              <form
                className="staff-email-modal-body"
                onSubmit={requestEmailChangeOtp}
              >
                <label>
                  <span>Current Email</span>
                  <input
                    type="email"
                    value={authenticatedUser?.email || ""}
                    readOnly
                    aria-readonly="true"
                  />
                </label>

                <label>
                  <span>Current Password</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={changeEmail.currentPassword}
                    onChange={(event) =>
                      setChangeEmailField(
                        "currentPassword",
                        event.target.value
                      )
                    }
                    disabled={changeEmail.isLoading}
                    placeholder="Enter current password"
                  />
                </label>

                <label>
                  <span>New Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={changeEmail.newEmail}
                    onChange={(event) =>
                      setChangeEmailField(
                        "newEmail",
                        event.target.value
                      )
                    }
                    disabled={changeEmail.isLoading}
                    placeholder="Enter new email address"
                  />
                </label>

                <div className="staff-email-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={closeChangeEmailModal}
                    disabled={changeEmail.isLoading}
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={changeEmail.isLoading}
                  >
                    {changeEmail.isLoading
                      ? "Sending..."
                      : "Send OTP"}
                  </button>
                </div>
              </form>
            )}

            {changeEmail.step === "currentOtp" && (
              <div className="staff-email-modal-body">
                <p className="staff-email-modal-help">
                  Enter the 6-digit OTP sent to{" "}
                  <strong>
                    {changeEmail.currentEmail ||
                      authenticatedUser?.email}
                  </strong>.
                </p>

                <label>
                  <span>Current Email OTP</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={changeEmail.currentEmailOtp}
                    onChange={(event) =>
                      setChangeEmailField(
                        "currentEmailOtp",
                        normalizeOtp(event.target.value)
                      )
                    }
                    disabled={changeEmail.isLoading}
                    maxLength={6}
                    placeholder="Enter OTP"
                  />
                </label>

                <div className="staff-email-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={() =>
                      resendEmailChangeOtp("current")
                    }
                    disabled={
                      changeEmail.isLoading ||
                      changeEmail.currentOtpCooldown > 0
                    }
                  >
                    {changeEmail.currentOtpCooldown > 0
                      ? `Resend in ${changeEmail.currentOtpCooldown}s`
                      : "Resend OTP"}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      verifyEmailChangeOtp("current")
                    }
                    disabled={changeEmail.isLoading}
                  >
                    {changeEmail.isLoading
                      ? "Verifying..."
                      : "Verify Current Email"}
                  </button>
                </div>
              </div>
            )}

            {changeEmail.step === "newOtp" && (
              <div className="staff-email-modal-body">
                <p className="staff-email-modal-help">
                  Enter the 6-digit OTP sent to{" "}
                  <strong>{changeEmail.pendingEmail}</strong>.
                </p>

                <label>
                  <span>New Email OTP</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={changeEmail.newEmailOtp}
                    onChange={(event) =>
                      setChangeEmailField(
                        "newEmailOtp",
                        normalizeOtp(event.target.value)
                      )
                    }
                    disabled={changeEmail.isLoading}
                    maxLength={6}
                    placeholder="Enter OTP"
                  />
                </label>

                <div className="staff-email-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={() =>
                      resendEmailChangeOtp("new")
                    }
                    disabled={
                      changeEmail.isLoading ||
                      changeEmail.newOtpCooldown > 0
                    }
                  >
                    {changeEmail.newOtpCooldown > 0
                      ? `Resend in ${changeEmail.newOtpCooldown}s`
                      : "Resend OTP"}
                  </button>

                  <button
                    type="button"
                    onClick={() => verifyEmailChangeOtp("new")}
                    disabled={changeEmail.isLoading}
                  >
                    {changeEmail.isLoading
                      ? "Verifying..."
                      : "Verify New Email"}
                  </button>
                </div>
              </div>
            )}

            {changeEmail.step === "complete" && (
              <div className="staff-email-modal-body">
                <div className="staff-email-complete">
                  <StaffIcon name="shield" />
                  <h3>Email changed successfully</h3>
                  <p>
                    Your staff login email is now{" "}
                    <strong>{settings.email}</strong>.
                  </p>
                </div>

                <div className="staff-email-modal-actions">
                  <button type="button" onClick={closeChangeEmailModal}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {changePasswordOtp.isOpen && (
        <div
          className="staff-email-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeChangePasswordOtpModal();
            }
          }}
        >
          <section
            className="staff-email-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-change-password-title"
          >
            <header className="staff-email-modal-header">
              <div>
                <span className="staff-email-modal-icon">
                  <StaffIcon name="key" />
                </span>

                <div>
                  <h2 id="staff-change-password-title">
                    Verify Password Change
                  </h2>
                  <p>
                    Enter the OTP sent to your current email to
                    update your password.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="staff-email-modal-close"
                onClick={closeChangePasswordOtpModal}
                disabled={changePasswordOtp.isLoading}
                aria-label="Close password OTP modal"
              >
                x
              </button>
            </header>

            <div
              className="staff-email-steps staff-password-steps"
              aria-hidden="true"
            >
              {[
                ["otp", "Verify OTP"],
                ["complete", "Complete"],
              ].map(([step, label], index) => (
                <span
                  key={step}
                  className={
                    changePasswordOtp.step === step ||
                    changePasswordOtp.step === "complete"
                      ? "is-active"
                      : ""
                  }
                >
                  {index + 1}
                  <small>{label}</small>
                </span>
              ))}
            </div>

            {changePasswordOtp.error && (
              <p className="staff-email-modal-message is-error">
                {changePasswordOtp.error}
              </p>
            )}

            {changePasswordOtp.success && (
              <p className="staff-email-modal-message is-success">
                {changePasswordOtp.success}
              </p>
            )}

            {changePasswordOtp.step === "otp" && (
              <div className="staff-email-modal-body">
                <p className="staff-email-modal-help">
                  Enter the 6-digit OTP sent to{" "}
                  <strong>
                    {changePasswordOtp.currentEmail ||
                      authenticatedUser?.email}
                  </strong>
                  .
                </p>

                <label>
                  <span>Password Change OTP</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={changePasswordOtp.otp}
                    onChange={(event) =>
                      setChangePasswordOtpField(
                        "otp",
                        normalizeOtp(event.target.value)
                      )
                    }
                    disabled={changePasswordOtp.isLoading}
                    maxLength={6}
                    placeholder="Enter OTP"
                  />
                </label>

                <div className="staff-email-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={resendPasswordChangeOtp}
                    disabled={
                      changePasswordOtp.isLoading ||
                      changePasswordOtp.otpCooldown > 0
                    }
                  >
                    {changePasswordOtp.otpCooldown > 0
                      ? `Resend in ${changePasswordOtp.otpCooldown}s`
                      : "Resend OTP"}
                  </button>

                  <button
                    type="button"
                    onClick={verifyPasswordOtpAndUpdate}
                    disabled={changePasswordOtp.isLoading}
                  >
                    {changePasswordOtp.isLoading
                      ? changePasswordOtp.loadingLabel ||
                        "Working..."
                      : "Verify & Update"}
                  </button>
                </div>
              </div>
            )}

            {changePasswordOtp.step === "complete" && (
              <div className="staff-email-modal-body">
                <div className="staff-email-complete">
                  <StaffIcon name="shield" />
                  <h3>Password updated successfully</h3>
                  <p>
                    Your password was changed. You will be
                    redirected to Login.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

export default StaffSettingsContent;
