import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { createStaffBookingRequestNotifications, emptyStaffBookingNotifications } from "../lib/staffBookingRequestNotifications";

export function useStaffBookingRequestNotifications(userId) {
  const controllerRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    if (!userId) return undefined;
    const controller = createStaffBookingRequestNotifications({ client: supabase, userId, onChange: data => setSnapshot({ ...data, userId }) });
    controllerRef.current = controller;
    return () => { controller.dispose(); if (controllerRef.current === controller) controllerRef.current = null; };
  }, [userId]);
  const refresh = useCallback(() => controllerRef.current?.refresh() || Promise.resolve({ ok: false }), []);
  const retry = useCallback(() => controllerRef.current?.retry(), []);
  const dismissToast = useCallback(() => controllerRef.current?.dismissToast(), []);
  return { ...(snapshot?.userId === userId ? snapshot : emptyStaffBookingNotifications), refresh, retry, dismissToast };
}
