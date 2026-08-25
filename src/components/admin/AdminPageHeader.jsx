export default function AdminPageHeader({ title, subtitle, className = "", children }) {
  return (
    <header className={`admin-page-header ${className}`.trim()}>
      {children}
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
    </header>
  );
}
