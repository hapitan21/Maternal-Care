import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "../../styles/inactivity-warning.css";

export default function InactivityWarningDialog({ secondsRemaining, onStayLoggedIn }) {
  const buttonRef = useRef(null);
  useEffect(() => {
    const priorFocus = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    buttonRef.current?.focus();
    const containFocus = (event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", containFocus, true);
    return () => {
      document.removeEventListener("keydown", containFocus, true);
      document.body.style.overflow = priorOverflow;
      if (priorFocus?.isConnected && !priorFocus.closest("[hidden], [inert]")) priorFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="inactivity-backdrop">
      <section className="inactivity-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="inactivity-title" aria-describedby="inactivity-description">
        <span className="inactivity-accent" aria-hidden="true">!</span>
        <h2 id="inactivity-title">Are you still there?</h2>
        <p id="inactivity-description">Your session will expire in 1 minute due to inactivity. Any unsaved changes may be lost.</p>
        <p className="inactivity-countdown" role="timer">Logging out in <strong>{secondsRemaining}</strong> seconds</p>
        <button ref={buttonRef} type="button" onClick={onStayLoggedIn}>Stay Logged In</button>
      </section>
    </div>, document.body
  );
}
