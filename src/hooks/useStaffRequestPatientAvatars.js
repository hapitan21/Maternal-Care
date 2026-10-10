import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { supabase } from "../lib/supabaseClient";
import { getStaffRequestAvatarCache } from "../lib/staffRequestPatientAvatars";

const cache = getStaffRequestAvatarCache(supabase);

export function useStaffRequestPatientAvatars(staffUserId, patientIds, enabled = true) {
  const idsKey = JSON.stringify([...new Set(patientIds.filter(Boolean).map(String))].sort());
  const subscribe = useCallback(listener => cache.subscribe(staffUserId, JSON.parse(idsKey), listener, enabled), [staffUserId, idsKey, enabled]);
  const getSnapshot = useCallback(() => cache.getSnapshot(staffUserId), [staffUserId]);
  // Read cached pictures on the first render after a route remount, before paint.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useLayoutEffect(() => cache.retainUrls(staffUserId, enabled
    ? JSON.parse(idsKey).map(id => snapshot.photos.get(id)).filter(Boolean) : []), [staffUserId, idsKey, enabled, snapshot]);
  const photos = snapshot.identity ? snapshot.photos : new Map();
  const loadingIds = new Set(enabled && staffUserId && (!snapshot.resolved || snapshot.identity)
    ? JSON.parse(idsKey).filter(id => !photos.has(id)) : []);
  return { photos, loadingIds };
}
