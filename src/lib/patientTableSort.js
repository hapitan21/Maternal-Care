const patientCollator = new Intl.Collator("en-PH", { sensitivity: "base", numeric: true });

export function comparePatientRows(first, second, key = "name", direction = "asc") {
  const comparison = patientCollator.compare(String(first[key] ?? ""), String(second[key] ?? ""));
  const tieBreak = patientCollator.compare(
    String(first.patientId ?? first.id ?? ""),
    String(second.patientId ?? second.id ?? ""),
  ) || String(first.recordId ?? "").localeCompare(String(second.recordId ?? ""));
  return (comparison || tieBreak) * (direction === "desc" ? -1 : 1);
}
