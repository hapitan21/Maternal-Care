import { useContext, useLayoutEffect } from "react";
import { RoleInactivityContext } from "../context/roleInactivityContext";

// The existing guards provide authorization; this bridge never queries profiles.
export function useRoleInactivityIdentity({ userId, role, authorized, revalidate, revision }) {
  const register = useContext(RoleInactivityContext);
  useLayoutEffect(() => {
    if (!register || !authorized || !userId) return undefined;
    return register({ userId, role, revalidate });
  }, [authorized, register, revalidate, revision, role, userId]);
}
