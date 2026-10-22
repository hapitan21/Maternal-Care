export default function WorkspaceSectionFallback({ label = "workspace section", compact = false }) {
  return (
    <div className={`workspace-section-loading${compact ? " workspace-section-loading--compact" : ""}`} role="status" aria-live="polite">
      <span aria-hidden="true" />
      <p>Loading {label}...</p>
    </div>
  );
}
