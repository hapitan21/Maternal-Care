export function normalizePhilippineMobileNumber(value) {
  const compact = String(value || "").replace(/[\s()-]/g, "");

  if (/^\+639\d{9}$/.test(compact)) return compact.slice(1);
  if (/^639\d{9}$/.test(compact)) return compact;
  if (/^09\d{9}$/.test(compact)) return `63${compact.slice(1)}`;
  if (/^9\d{9}$/.test(compact)) return `63${compact}`;

  return null;
}

export function isValidPhilippineMobileNumber(value) {
  return Boolean(normalizePhilippineMobileNumber(value));
}
