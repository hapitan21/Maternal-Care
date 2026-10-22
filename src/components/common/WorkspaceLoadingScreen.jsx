import MaternalCareLogo from "./MaternalCareLogo";
import { useLocation } from "react-router-dom";
import "../../styles/workspace-loading.css";

// Shared with Patient startup. Data and chunk loads use WorkspaceSectionFallback.
export default function WorkspaceLoadingScreen({ message = "Maternal Care" }) {
  const { pathname } = useLocation();
  const showMessage = !/^\/(?:admin|doctor|staff)(?:\/|$)/.test(pathname);

  return (
    <div className="maternal-workspace-loading">
      <div className="maternal-workspace-loading-card" role="status" aria-label={showMessage ? undefined : message}>
        <MaternalCareLogo decorative variant="status" />
        {showMessage ? <span>{message}</span> : null}
      </div>
    </div>
  );
}
