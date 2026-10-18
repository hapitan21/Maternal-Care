// Input must be the current authenticated health_tips SELECT result. Never merge browser-authored tips.
// is_active is the existing Doctor publish/archive contract; no separate clinical approval RPC exists here.
export function getPatientHealthTips(rows, patientId) {
  if (!patientId) return [];
  const seen = new Set();
  return (rows || []).filter(row => {
    if (!row?.id || row.is_active !== true || !String(row.content || "").trim()) return false;
    if (row.patient_id != null && row.patient_id !== patientId) return false;
    if (row.archived_at || row.deleted_at || row.is_approved === false) return false;
    if (row.approval_status && row.approval_status !== "approved") return false;
    if (row.status && !["active", "approved", "published"].includes(row.status)) return false;
    if (seen.has(String(row.id))) return false;
    seen.add(String(row.id));
    return true;
  }).map(row => ({
    id: String(row.id), category: row.category || "General Health",
    title: row.title || row.category || "Health Tip", text: String(row.content).trim(),
    image: row.image_url || "", displaySchedule: row.display_schedule || "Daily",
    patientId: row.patient_id || "", databaseBacked: true,
    publishedAt: row.published_at || row.created_at || "",
  }));
}

// Selection stores IDs/date only. The rendered content always comes from the current authorized list.
export function selectDailyHealthTip(tips, dateKey, previous) {
  const eligible = tips.filter(tip => String(tip.displaySchedule || "Daily").trim().toLowerCase() === "daily")
    .slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!eligible.length) return null;
  const existing = eligible.find(tip => tip.id === previous?.tipId);
  if (previous?.dateKey === dateKey && existing) return { dateKey, tipId: existing.id };
  const day = Math.floor(Date.parse(dateKey + "T00:00:00Z") / 86400000);
  if (!Number.isFinite(day)) return null;
  const index = existing ? (eligible.indexOf(existing) + 1) % eligible.length : day % eligible.length;
  return { dateKey, tipId: eligible[index].id };
}
