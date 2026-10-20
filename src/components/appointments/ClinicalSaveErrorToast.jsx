import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, X } from "lucide-react";
import { useAppointmentToastPlacement } from "../../hooks/useAppointmentToastPlacement";
import "../../styles/appointment-ui-system.css";

export default function ClinicalSaveErrorToast({ message, onDismiss }) {
  const [visible, setVisible] = useState(true);
  const ref = useAppointmentToastPlacement(visible ? message : "", message);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 5000);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return createPortal(
    <div className="appointment-success-toast" ref={ref} role="alert" aria-atomic="true">
      <CircleAlert aria-hidden="true" />
      <div className="appointment-success-toast__copy">
        <strong>Save needs attention</strong>
        <span>{message}</span>
      </div>
      <button type="button" className="appointment-success-toast__close" aria-label="Dismiss save notification" onClick={onDismiss}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>,
    document.body
  );
}
