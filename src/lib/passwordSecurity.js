export const PASSWORD_MIN_LENGTH = 12;

export const PASSWORD_REQUIREMENTS = [
  { key: "minLength", label: `At least ${PASSWORD_MIN_LENGTH} characters` },
  { key: "uppercase", label: "At least one uppercase letter" },
  { key: "lowercase", label: "At least one lowercase letter" },
  { key: "number", label: "At least one number" },
  { key: "special", label: "At least one special character (!@#$%^&*)" },
];

const COMMON_PASSWORD_WORDS = new Set([
  "admin",
  "changeme",
  "iloveyou",
  "letmein",
  "maternalcare",
  "password",
  "qwerty",
  "welcome",
]);

function isCommonPassword(value) {
  const normalized = String(value || "").toLowerCase();
  const lettersOnly = normalized.replace(/[^a-z]/g, "");

  return (
    COMMON_PASSWORD_WORDS.has(normalized) ||
    COMMON_PASSWORD_WORDS.has(lettersOnly) ||
    /^(.)\1{7,}$/.test(normalized) ||
    /(?:123456|abcdef|qwerty)/.test(normalized)
  );
}

export function validatePassword(value) {
  const password = String(value || "");
  const requirements = {
    minLength: password.length >= PASSWORD_MIN_LENGTH,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    special: /[!@#$%^&*]/.test(password),
  };
  const passedRequirementCount = Object.values(requirements).filter(Boolean).length;
  const valid = Object.values(requirements).every(Boolean);
  const common = isCommonPassword(password);
  const uniqueCharacterCount = new Set(password).size;

  let score = password ? 1 : 0;
  if (password.length >= 8 && passedRequirementCount >= 3) score = 2;
  if (valid) score = 3;
  if (
    valid &&
    password.length >= 16 &&
    uniqueCharacterCount >= 10 &&
    !common
  ) {
    score = 4;
  }
  if (common) score = Math.min(score, 2);

  const labels = ["Weak", "Weak", "Moderate", "Good", "Strong"];

  return {
    valid,
    common,
    score,
    strength: labels[score],
    requirements,
    unmetRequirements: PASSWORD_REQUIREMENTS.filter(
      ({ key }) => !requirements[key]
    ),
  };
}

export function passwordsMatch(password, confirmation) {
  return Boolean(confirmation) && password === confirmation;
}

export function getPasswordValidationMessage(value) {
  const result = validatePassword(value);

  if (result.valid) return "";

  return `Password must meet these requirements: ${result.unmetRequirements
    .map(({ label }) => label.toLowerCase())
    .join(", ")}.`;
}
