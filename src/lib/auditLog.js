import { supabase } from "./supabaseClient";

const missingAuditInfrastructureCodes = new Set([
  "42P01",
  "42883",
  "PGRST202",
  "PGRST204",
  "PGRST205",
]);
const loggedAuditErrors = new Set();

function cleanOptionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

export function isMissingAuditInfrastructure(error) {
  return missingAuditInfrastructureCodes.has(String(error?.code || ""));
}

export function logAuditError(error, context = "Audit event") {
  if (!import.meta.env.DEV || !error) return;
  const fingerprint = [context, error.code, error.message, error.details, error.hint]
    .map((value) => String(value || ""))
    .join("|");
  if (loggedAuditErrors.has(fingerprint)) return;
  loggedAuditErrors.add(fingerprint);
  console.error(`${context} failed:`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}

export async function recordAuditEvent({
  module,
  action,
  entityType,
  entityId,
  description,
  metadata = {},
  requestId,
}) {
  const { data, error } = await supabase.rpc("record_audit_event", {
    p_module: cleanOptionalText(module),
    p_action: cleanOptionalText(action),
    p_entity_type: cleanOptionalText(entityType),
    p_entity_id: cleanOptionalText(entityId),
    p_description: cleanOptionalText(description),
    p_metadata: metadata && typeof metadata === "object" ? metadata : {},
    p_request_id: requestId || null,
  });

  if (error) {
    logAuditError(error);
    return { data: null, error };
  }

  return { data, error: null };
}
