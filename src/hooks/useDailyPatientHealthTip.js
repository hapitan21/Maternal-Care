import { useEffect, useMemo, useState } from "react";
import { getManilaDateKey } from "../lib/appointmentDate";
import { selectDailyHealthTip } from "../lib/patientHealthTips";

const selections = new Map();
const keyFor = patientId => "maternal-daily-health-tip-v1:" + encodeURIComponent(patientId);

function readSelection(patientId) {
  if (selections.has(patientId)) return selections.get(patientId);
  try {
    const saved = JSON.parse(window.localStorage.getItem(keyFor(patientId)) || "null");
    if (/^\d{4}-\d{2}-\d{2}$/.test(saved?.dateKey) && typeof saved?.tipId === "string") return saved;
  } catch { /* Date-based selection still works when storage is blocked. */ }
  return selections.get(patientId) || null;
}

export function useDailyPatientHealthTip(tips, patientId) {
  const [dateKey, setDateKey] = useState(() => getManilaDateKey());
  useEffect(() => {
    let timer;
    const delay = () => Math.max(50, Date.parse(getManilaDateKey() + "T00:00:00+08:00") + 86400000 - Date.now() + 50);
    const sync = () => {
      setDateKey(getManilaDateKey());
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, delay());
    };
    timer = window.setTimeout(sync, delay());
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  const selection = useMemo(() => patientId
    ? selectDailyHealthTip(tips, dateKey, readSelection(patientId)) : null,
  [tips, patientId, dateKey]);
  useEffect(() => {
    if (!selection || !patientId) return;
    selections.set(patientId, selection);
    try { window.localStorage.setItem(keyFor(patientId), JSON.stringify(selection)); } catch { /* Memory fallback. */ }
  }, [selection, patientId]);
  return tips.find(tip => tip.id === selection?.tipId) || null;
}
