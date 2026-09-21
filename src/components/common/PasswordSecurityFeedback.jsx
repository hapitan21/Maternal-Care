import { Icon } from "@iconify/react";
import {
  PASSWORD_REQUIREMENTS,
  passwordsMatch,
  validatePassword,
} from "../../lib/passwordSecurity";
import "../../styles/password-security.css";

export default function PasswordSecurityFeedback({
  password,
  confirmPassword = "",
  confirmInteracted = false,
  className = "",
}) {
  const result = validatePassword(password);
  const showMatch = confirmInteracted && Boolean(confirmPassword);
  const matches = passwordsMatch(password, confirmPassword);
  const strengthToken = result.strength.toLowerCase();

  return (
    <section
      className={`password-security-feedback ${className}`.trim()}
      aria-label="Password security"
    >
      <div className="password-strength-heading">
        <span>Password strength</span>
        <strong className={`is-${strengthToken}`}>
          {password ? result.strength : "Not entered"}
        </strong>
      </div>

      <div
        className="password-strength-meter"
        role="progressbar"
        aria-label="Password strength"
        aria-valuemin="0"
        aria-valuemax="4"
        aria-valuenow={result.score}
        aria-valuetext={password ? result.strength : "No password entered"}
      >
        {[1, 2, 3, 4].map((level) => (
          <span
            className={level <= result.score ? `is-active is-${strengthToken}` : ""}
            key={level}
          />
        ))}
      </div>

      <ul className="password-requirements" aria-label="Password requirements">
        {PASSWORD_REQUIREMENTS.map(({ key, label }) => {
          const valid = result.requirements[key];
          return (
            <li className={valid ? "is-valid" : ""} key={key}>
              <Icon
                icon={valid ? "solar:check-circle-bold" : "solar:circle-linear"}
                aria-hidden="true"
              />
              <span>{label}</span>
            </li>
          );
        })}
      </ul>

      {result.common ? (
        <p className="password-common-warning" role="status">
          <Icon icon="solar:shield-warning-linear" aria-hidden="true" />
          This password uses a common pattern. Choose something less predictable.
        </p>
      ) : null}

      {showMatch ? (
        <p
          className={`password-match-message ${matches ? "is-match" : "is-mismatch"}`}
          role={matches ? "status" : "alert"}
        >
          <Icon
            icon={matches ? "solar:check-circle-bold" : "solar:danger-circle-bold"}
            aria-hidden="true"
          />
          {matches ? "Passwords match." : "Passwords do not match."}
        </p>
      ) : null}
    </section>
  );
}
