import { Icon } from "@iconify/react";
import WorkspaceLoadingScreen from "../common/WorkspaceLoadingScreen";

export default function AdminPageState({ type = "loading", message, onRetry }) {
  const isLoading = type === "loading";

  if (isLoading) return <WorkspaceLoadingScreen />;

  return (
    <main
      className={`admin-auth-state is-${type}`}
      role="alert"
      aria-live="assertive"
    >
      <Icon icon="solar:shield-warning-linear" aria-hidden="true" />
      <p>{message || "Admin access could not be verified."}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>Retry</button>
      ) : null}
    </main>
  );
}
