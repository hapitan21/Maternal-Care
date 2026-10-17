import { useCallback, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  isAllowedPatientNotificationTarget,
  isAllowedPatientNotificationType,
  isUuid,
} from "../lib/patientNotificationTypes";

const allowedPriorities = new Set(["normal", "important", "urgent"]);

function getNotificationErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();

  if (message.includes("schema cache") || error?.code === "PGRST202") {
    return "The notification service is still refreshing. Please try again shortly.";
  }

  if (message.includes("not active") || message.includes("not linked")) {
    return "This Patient account is inactive or not linked yet.";
  }

  if (message.includes("does not belong") || message.includes("patient mismatch")) {
    return "The selected appointment, record, or reminder does not belong to this Patient.";
  }

  if (message.includes("role") || message.includes("permission") || message.includes("authorized")) {
    return "Your account is not authorized to send Patient notifications.";
  }

  if (message.includes("target") || message.includes("path")) {
    return "The selected Patient destination is not allowed.";
  }

  if (message.includes("type")) {
    return "The selected notification type is not supported.";
  }

  if (message.includes("fetch") || message.includes("network")) {
    return "The notification could not be sent because of a network problem.";
  }

  return "The notification could not be sent. Please review the details and try again.";
}

function validateRelatedId(value, label) {
  if (!value) return null;
  if (!isUuid(value)) {
    throw new Error(`${label} is not a valid verified record identifier.`);
  }
  return value;
}

export function useSendPatientNotification() {
  const [isSending, setIsSending] = useState(false);
  const submissionLockRef = useRef(false);
  const unconfirmedSubmissionRef = useRef(false);

  const sendPatientNotification = useCallback(async (notification) => {
    if (submissionLockRef.current) {
      throw new Error("A notification is already being sent.");
    }
    if (unconfirmedSubmissionRef.current) {
      throw new Error("The previous notification may have been created. Verify it before sending another; it has not been sent again.");
    }

    const patientId = String(notification?.patientId || "").trim();
    const type = String(notification?.type || "").trim();
    const title = String(notification?.title || "").trim();
    const message = String(notification?.message || "").trim();
    const priority = String(notification?.priority || "").trim();
    const targetPath = String(notification?.targetPath || "").trim();

    if (!isUuid(patientId)) throw new Error("Select a valid Patient before sending.");
    if (!isAllowedPatientNotificationType(type)) {
      throw new Error("Select a supported notification type.");
    }
    if (!title || title.length > 120) {
      throw new Error("Title must contain 1 to 120 characters.");
    }
    if (!message || message.length > 500) {
      throw new Error("Message must contain 1 to 500 characters.");
    }
    if (!allowedPriorities.has(priority)) {
      throw new Error("Select a valid notification priority.");
    }
    if (!isAllowedPatientNotificationTarget(targetPath)) {
      throw new Error("Select an allowed Patient destination.");
    }

    const appointmentId = validateRelatedId(
      notification?.appointmentId,
      "Appointment ID"
    );
    const medicalRecordId = validateRelatedId(
      notification?.medicalRecordId,
      "Medical record ID"
    );
    const reminderId = validateRelatedId(notification?.reminderId, "Reminder ID");

    submissionLockRef.current = true;
    setIsSending(true);

    try {
      const payload = {
        p_patient_id: patientId,
        p_type: type,
        p_title: title,
        p_message: message,
        p_target_path: targetPath,
        p_priority: priority,
        p_related_appointment_id: appointmentId,
        p_related_medical_record_id: medicalRecordId,
        p_related_reminder_id: reminderId,
      };
      unconfirmedSubmissionRef.current = true;
      const { data, error } = await supabase.rpc(
        "create_patient_notification",
        payload
      );

      if (error) {
        console.error("Patient notification RPC failed.", {
          code: error.code || "unknown",
          category: getNotificationErrorMessage(error),
        });
        // These explicit SQL exceptions reject this transaction. A transport
        // error (even a thrown object with a similar code) proves no rollback.
        if (data == null && ["42501", "22023", "23503", "P0002"].includes(error.code)) {
          unconfirmedSubmissionRef.current = false;
          throw new Error(getNotificationErrorMessage(error));
        }
        throw new Error("Notification creation could not be confirmed. It may have been saved; verify before sending again.");
      }

      const record = Array.isArray(data) && data.length === 1 ? data[0] : data;
      const expectedFields = {
        patient_id: patientId,
        type,
        title,
        message,
        priority,
        target_path: targetPath,
        related_appointment_id: appointmentId,
        related_medical_record_id: medicalRecordId,
        related_reminder_id: reminderId,
      };
      if (!record || Array.isArray(record) || !isUuid(record.id) ||
          Object.entries(expectedFields).some(([key, value]) => record[key] !== value)) {
        throw new Error("Notification creation could not be confirmed. It may have been saved; verify before sending again.");
      }
      unconfirmedSubmissionRef.current = false;
      // This confirms the database record only, not FCM or SMS delivery.
      return record;
    } catch (error) {
      if (!unconfirmedSubmissionRef.current) throw error;
      throw new Error("Notification creation could not be confirmed. It may have been saved; verify before sending again.", { cause: error });
    } finally {
      submissionLockRef.current = false;
      setIsSending(false);
    }
  }, []);

  return {
    isSending,
    sendPatientNotification,
  };
}
