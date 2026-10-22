const accountStatuses = new Set(["active", "inactive", "deactivated", "suspended", "pending_activation", "archived"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getAuditEventDetails(event) {
  // A dedicated origin takes precedence over legacy, potentially client-supplied metadata.
  // A successful RPC report is still a client claim on the staging schema.
  const source = event.event_origin === "client_reported"
    ? "Client reported (unverified)"
    : event.event_origin === "server_verified"
      ? event.status === "reported" ? "Conflicting source markers (unverified)" : "Server verified"
      : event.event_origin != null
        ? "Unrecognized source (unverified)"
        : event.status === "reported" || event.audit_source === "client_reported"
          ? "Client reported (unverified)"
          : event.audit_source === "server_transaction"
            ? "Server transaction (metadata marker)"
            : "Not recorded (legacy event)";
  return [
    ["Recorded Source", source],
    ["Request ID", uuid.test(event.request_id || "") ? event.request_id : "Not recorded"],
    ...["previous_status", "new_status"].flatMap(key => accountStatuses.has(event[key])
      ? [[key === "previous_status" ? "Previous Account Status" : "New Account Status", event[key]]]
      : []),
  ];
}
