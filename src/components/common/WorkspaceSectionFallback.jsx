export default function WorkspaceSectionFallback({ label = "workspace section" }) {
  return (
    <div className="workspace-section-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      <p>Loading {label}...</p>
    </div>
  );
}
