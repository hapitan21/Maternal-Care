import { useContext } from "react";
import { PatientNotificationsContext } from "./patientNotificationsContext";

export function usePatientNotifications() {
  const context = useContext(PatientNotificationsContext);

  if (!context) {
    throw new Error(
      "usePatientNotifications must be used inside PatientNotificationsProvider."
    );
  }

  return context;
}
