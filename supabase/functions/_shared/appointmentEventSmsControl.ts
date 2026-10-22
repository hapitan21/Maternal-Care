// The only transactional appointment SMS control. Read from a service-only RPC;
// never trust a request-body flag or cache an enabled decision across requests.
export async function evaluateAppointmentEventSmsControl(
  notificationType: unknown,
  readEnabled: () => Promise<unknown>,
): Promise<"enabled" | "disabled" | "unsupported"> {
  if (
    notificationType === "appointment_reminder" ||
    notificationType === "medication_reminder"
  ) {
    // Scheduled reminder bridges retain their own independent controls.
    return "enabled";
  }
  if (
    notificationType !== "appointment_confirmed" &&
    notificationType !== "appointment_rescheduled" &&
    notificationType !== "appointment_cancelled"
  ) {
    return "unsupported";
  }
  try {
    // The RPC contract is one scalar boolean. Malformed responses fail closed.
    return await readEnabled() === true ? "enabled" : "disabled";
  } catch {
    return "disabled";
  }
}
