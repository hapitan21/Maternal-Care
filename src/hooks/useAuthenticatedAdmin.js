import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function cleanText(value) {
  return String(value || "").trim();
}

function getEmailUsername(email) {
  const cleanEmail = cleanText(email);
  return cleanEmail ? cleanEmail.split("@")[0] : "";
}

function getAdminDisplayName(authUser, profile) {
  return (
    cleanText(profile?.full_name) ||
    cleanText(authUser?.user_metadata?.full_name) ||
    cleanText(authUser?.user_metadata?.name) ||
    getEmailUsername(authUser?.email) ||
    "Admin profile not found"
  );
}

function getMetadataAvatar(authUser) {
  const metadata = authUser?.user_metadata || {};
  const avatarUrl =
    metadata.avatar_url ||
    metadata.picture ||
    metadata.profile_image_url ||
    metadata.photo_url ||
    "";

  return /^https?:\/\//i.test(String(avatarUrl || "").trim())
    ? String(avatarUrl).trim()
    : "";
}

export function useAuthenticatedAdmin() {
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const identityRef = useRef(null);
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const hasIdentity = Boolean(identityRef.current);

    if (mountedRef.current) {
      setLoading(!hasIdentity);
      if (!hasIdentity) setError(null);
    }

    try {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError) throw authError;

      if (!user?.id) {
        const unauthenticatedError = new Error("No authenticated Admin account was found.");
        unauthenticatedError.code = "admin_not_authenticated";
        throw unauthenticatedError;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, full_name, email, role, account_status")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError) throw profileError;

      const role = cleanText(profile?.role).toLowerCase();

      if (role !== "admin") {
        const roleError = new Error("The authenticated account is not assigned the Admin role.");
        roleError.code = "admin_role_mismatch";
        roleError.role = role || "";
        throw roleError;
      }

      const accountStatus = cleanText(profile?.account_status).toLowerCase();
      if (accountStatus !== "active") {
        const statusError = new Error("The Admin account is not active.");
        statusError.code = "admin_account_inactive";
        throw statusError;
      }

      const nextIdentity = {
        authUser: user,
        profile,
        role: "admin",
        displayName: getAdminDisplayName(user, profile),
        email: cleanText(profile?.email) || cleanText(user.email),
        avatarUrl: getMetadataAvatar(user),
      };

      if (mountedRef.current && requestIdRef.current === requestId) {
        identityRef.current = nextIdentity;
        setIdentity(nextIdentity);
        setError(null);
        setLoading(false);
      }

      return nextIdentity;
    } catch (nextError) {
      if (mountedRef.current && requestIdRef.current === requestId) {
        identityRef.current = null;
        setIdentity(null);
        setError(nextError);
        setLoading(false);
      }

      return null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(refresh, 0);
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        const unauthenticatedError = new Error("No authenticated Admin account was found.");
        unauthenticatedError.code = "admin_not_authenticated";
        identityRef.current = null;
        setIdentity(null);
        setError(unauthenticatedError);
        setLoading(false);
        return;
      }

      if (
        event === "USER_UPDATED" ||
        (event === "SIGNED_IN" && session?.user?.id !== identityRef.current?.authUser?.id)
      ) {
        refresh();
      }
    });

    return () => {
      mountedRef.current = false;
      window.clearTimeout(timer);
      authListener.subscription.unsubscribe();
    };
  }, [refresh]);

  return {
    identity,
    user: identity?.authUser || null,
    authUser: identity?.authUser || null,
    profile: identity?.profile || null,
    role: identity?.role || "",
    displayName: identity?.displayName || "",
    email: identity?.email || "",
    avatarUrl: identity?.avatarUrl || "",
    loading,
    error,
    isAdmin: Boolean(identity?.role === "admin"),
    refresh,
    refreshProfile: refresh,
  };
}
