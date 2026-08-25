export function parseAppointmentVisitRoute(pathname, workspace) {
  const expression = new RegExp(
    `^/${workspace}/appointments/([^/]+)/(initial-visit|follow-up)/?$`,
    "i"
  );
  const match = String(pathname || "").match(expression);
  if (!match) return null;

  let appointmentId = match[1];
  try {
    appointmentId = decodeURIComponent(appointmentId);
  } catch {
    return null;
  }

  return {
    appointmentId,
    requestedType: match[2].toLowerCase() === "initial-visit" ? "initial" : "follow_up",
  };
}
