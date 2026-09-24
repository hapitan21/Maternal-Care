export type SmsDispatchRow = {
  id: string;
  patient_id: string;
  channel: string;
  status: string;
  provider: string | null;
};

type ReservationQueryResult = {
  data: SmsDispatchRow | null;
  error: unknown | null;
};

export type SmsTransportReservationStore = {
  tryReserve: (
    dispatchId: string,
    updatedAt: string,
  ) => Promise<ReservationQueryResult>;
  load: (dispatchId: string) => Promise<ReservationQueryResult>;
};

export type SmsTransportReservation =
  | { outcome: "reserved"; dispatch: SmsDispatchRow }
  | { outcome: "idempotent"; dispatch: SmsDispatchRow }
  | { outcome: "already_started"; dispatch: SmsDispatchRow }
  | { outcome: "not_sendable"; dispatch: SmsDispatchRow }
  | { outcome: "not_found"; dispatch: null };

export class SmsTransportReservationError extends Error {
  operation: "reserve_transport" | "reload_dispatch";

  constructor(operation: "reserve_transport" | "reload_dispatch") {
    super("database_error");
    this.name = "SmsTransportReservationError";
    this.operation = operation;
  }
}

export async function reserveSmsTransport(
  store: SmsTransportReservationStore,
  dispatchId: string,
  updatedAt = new Date().toISOString(),
): Promise<SmsTransportReservation> {
  const reservation = await store.tryReserve(dispatchId, updatedAt);
  if (reservation.error) {
    throw new SmsTransportReservationError("reserve_transport");
  }
  if (reservation.data) {
    return { outcome: "reserved", dispatch: reservation.data };
  }

  const current = await store.load(dispatchId);
  if (current.error) {
    throw new SmsTransportReservationError("reload_dispatch");
  }
  if (!current.data) {
    return { outcome: "not_found", dispatch: null };
  }
  if (
    current.data.channel === "sms" &&
    (current.data.status === "sent" || current.data.status === "delivered")
  ) {
    return { outcome: "idempotent", dispatch: current.data };
  }
  if (
    current.data.channel === "sms" &&
    current.data.status === "processing" &&
    current.data.provider === "semaphore"
  ) {
    return { outcome: "already_started", dispatch: current.data };
  }

  return { outcome: "not_sendable", dispatch: current.data };
}

export function mayContactSemaphore(
  reservation: SmsTransportReservation,
): reservation is Extract<SmsTransportReservation, { outcome: "reserved" }> {
  return reservation.outcome === "reserved";
}

export async function executeWithSmsTransportReservation<T>(
  reservation: SmsTransportReservation,
  transport: () => Promise<T>,
): Promise<{ executed: false } | { executed: true; value: T }> {
  if (!mayContactSemaphore(reservation)) {
    return { executed: false };
  }

  return { executed: true, value: await transport() };
}

export function buildSmsDispatchSuccessUpdate(
  providerMessageId: string,
  updatedAt: string,
): Record<string, string | null> {
  return {
    status: "sent",
    provider: "semaphore",
    provider_message_id: providerMessageId,
    sent_at: updatedAt,
    failed_at: null,
    last_error: null,
    updated_at: updatedAt,
  };
}

export function buildSmsDispatchFailureUpdate(
  safeError: string,
  updatedAt: string,
): Record<string, string> {
  return {
    status: "failed",
    provider: "semaphore",
    failed_at: updatedAt,
    last_error: safeError,
    updated_at: updatedAt,
  };
}
