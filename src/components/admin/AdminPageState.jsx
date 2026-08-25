import { Icon } from "@iconify/react";

export default function AdminPageState({ type = "loading", message, onRetry }) {
  const isLoading = type === "loading";

  return (
    <main
      className={`admin-auth-state is-${type}`}
      role={isLoading ? "status" : "alert"}
      aria-live={isLoading ? "polite" : "assertive"}
    >
      {isLoading ? (
        <span className="admin-layout-skeleton-avatar" aria-hidden="true" />
      ) : (
        <Icon icon="solar:shield-warning-linear" aria-hidden="true" />
      )}
      <p>{message || (isLoading ? "Loading Admin profile..." : "Admin access could not be verified.")}</p>
      {!isLoading && onRetry ? (
        <button type="button" onClick={onRetry}>Retry</button>
      ) : null}
    </main>
  );
}
