import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuthenticatedAdmin } from "../hooks/useAuthenticatedAdmin";
import { recordAuditEvent } from "../lib/auditLog";
import { supabase } from "../lib/supabaseClient";
import { AdminAuthContext } from "./adminAuthContextValue";

export function AdminAuthProvider({ children }) {
  const navigate = useNavigate();
  const access = useAuthenticatedAdmin();
  const logoutPromiseRef = React.useRef(null);

  const logout = React.useCallback(() => {
    if (logoutPromiseRef.current) return logoutPromiseRef.current;

    const request = (async () => {
      await recordAuditEvent({
        module: "authentication",
        action: "logout",
        entityType: "auth_user",
        description: "User logged out.",
      });

      const { error } = await supabase.auth.signOut();
      if (error) throw error;

      navigate("/login?logout=1", { replace: true });
    })();

    logoutPromiseRef.current = request;
    request.catch(() => {
      logoutPromiseRef.current = null;
    });
    return request;
  }, [navigate]);

  const value = React.useMemo(
    () => ({
      user: access.authUser,
      profile: access.profile,
      identity: access.identity,
      loading: access.loading,
      error: access.error,
      isAdmin: access.isAdmin,
      refreshProfile: access.refresh,
      logout,
    }),
    [access.authUser, access.error, access.identity, access.isAdmin, access.loading, access.profile, access.refresh, logout]
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}
