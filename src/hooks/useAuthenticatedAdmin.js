import { useCallback, useEffect, useRef, useState } from "react";

import { clearAdminWorkspaceSnapshots } from "../lib/adminWorkspaceSnapshots";
import { supabase } from "../lib/supabaseClient";

function cleanText(value) {
  return String(value || "").trim();
}

function getEmailUsername(email) {
  const cleanEmail = cleanText(email);

  return cleanEmail
    ? cleanEmail.split("@")[0]
    : "";
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

  return /^https?:\/\//i.test(
    String(avatarUrl || "").trim()
  )
    ? String(avatarUrl).trim()
    : "";
}

function createAdminAccessError(message, code) {
  const error = new Error(message);
  error.code = code;

  return error;
}

function isMissingAuthSessionError(error) {
  const errorName =
    cleanText(error?.name).toLowerCase();

  const errorMessage =
    cleanText(error?.message).toLowerCase();

  return (
    errorName === "authsessionmissingerror" ||
    errorMessage.includes("auth session missing") ||
    errorMessage.includes("session missing")
  );
}

/*
 * Keep the Realtime connection synchronized with the current authenticated
 * Supabase access token.
 *
 * This is especially important for private Broadcast channels because their
 * authorization is evaluated against the authenticated JWT.
 */
async function synchronizeRealtimeAuth(session) {
  const accessToken = cleanText(
    session?.access_token
  );

  if (!accessToken) {
    return false;
  }

  await supabase.realtime.setAuth(
    accessToken
  );

  return true;
}

export function useAuthenticatedAdmin() {
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const identityRef = useRef(null);

  const [identity, setIdentity] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);

  const refresh = useCallback(async () => {
    const requestId =
      requestIdRef.current + 1;

    requestIdRef.current = requestId;

    const hasIdentity = Boolean(
      identityRef.current
    );

    if (mountedRef.current) {
      setLoading(!hasIdentity);

      if (!hasIdentity) {
        setError(null);
      }
    }

    try {
      /*
       * Verify the currently authenticated Supabase user.
       */
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError) {
        if (
          isMissingAuthSessionError(
            authError
          )
        ) {
          throw createAdminAccessError(
            "No authenticated Admin account was found.",
            "admin_not_authenticated"
          );
        }

        throw authError;
      }

      if (!user?.id) {
        throw createAdminAccessError(
          "No authenticated Admin account was found.",
          "admin_not_authenticated"
        );
      }

      /*
       * Verify the authoritative Admin profile and account state.
       */
      const {
        data: profile,
        error: profileError,
      } = await supabase
        .from("profiles")
        .select(
          "id, full_name, email, role, account_status"
        )
        .eq("id", user.id)
        .maybeSingle();

      if (profileError) {
        throw profileError;
      }

      const role =
        cleanText(
          profile?.role
        ).toLowerCase();

      if (role !== "admin") {
        const roleError = new Error(
          "The authenticated account is not assigned the Admin role."
        );

        roleError.code =
          "admin_role_mismatch";

        roleError.role =
          role || "";

        throw roleError;
      }

      const accountStatus =
        cleanText(
          profile?.account_status
        ).toLowerCase();

      if (accountStatus !== "active") {
        const statusError =
          new Error(
            "The Admin account is not active."
          );

        statusError.code =
          "admin_account_inactive";

        throw statusError;
      }

      /*
       * Synchronize the authenticated Admin JWT with Realtime before
       * publishing isAdmin=true to the rest of the application.
       *
       * AdminDashboard only enables its private Broadcast subscription once
       * this successful Admin identity has been published.
       */
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        throw sessionError;
      }

      if (
        session?.access_token &&
        session?.user?.id === user.id
      ) {
        try {
          await synchronizeRealtimeAuth(
            session
          );
        } catch {
          /*
           * Do not fail Admin authorization solely because Realtime
           * synchronization temporarily failed.
           *
           * The Dashboard still has focus refresh and polling as safety
           * fallbacks, and future Auth events will attempt synchronization
           * again.
           */
        }
      }

      const nextIdentity = {
        authUser: user,
        profile,
        role: "admin",

        displayName:
          getAdminDisplayName(
            user,
            profile
          ),

        email:
          cleanText(profile?.email) ||
          cleanText(user.email),

        avatarUrl:
          getMetadataAvatar(user),
      };

      if (
        mountedRef.current &&
        requestIdRef.current ===
          requestId
      ) {
        identityRef.current =
          nextIdentity;

        setIdentity(
          nextIdentity
        );

        setError(null);
        setLoading(false);
      }

      return nextIdentity;
    } catch (nextError) {
      if (
        mountedRef.current &&
        requestIdRef.current ===
          requestId
      ) {
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

    const timer =
      window.setTimeout(
        refresh,
        0
      );

    /*
     * Keep the Realtime authorization token synchronized when Supabase
     * signs in, refreshes a JWT, or updates the authenticated account.
     */
    const { data: authListener } =
      supabase.auth.onAuthStateChange(
        (event, session) => {
          if (
            event === "SIGNED_OUT"
          ) {
            clearAdminWorkspaceSnapshots();

            const unauthenticatedError =
              createAdminAccessError(
                "No authenticated Admin account was found.",
                "admin_not_authenticated"
              );

            identityRef.current =
              null;

            setIdentity(null);

            setError(
              unauthenticatedError
            );

            setLoading(false);

            return;
          }

          if (
            session?.access_token &&
            (
              event === "INITIAL_SESSION" ||
              event === "SIGNED_IN" ||
              event === "TOKEN_REFRESHED" ||
              event === "USER_UPDATED"
            )
          ) {
            void synchronizeRealtimeAuth(
              session
            ).catch(() => {
              /*
               * Realtime synchronization can retry on the next Auth event.
               * Do not invalidate an otherwise valid Admin session.
               */
            });
          }

          /*
           * Preserve the existing Admin profile/account authorization
           * revalidation behavior.
           */
          if (
            event === "USER_UPDATED" ||
            (
              event === "SIGNED_IN" &&
              session?.user?.id !==
                identityRef.current
                  ?.authUser?.id
            )
          ) {
            if (
              event === "SIGNED_IN" &&
              identityRef.current
                ?.authUser?.id &&
              session?.user?.id !==
                identityRef.current
                  .authUser.id
            ) {
              clearAdminWorkspaceSnapshots();
            }

            void refresh();
          }
        }
      );

    return () => {
      mountedRef.current = false;

      window.clearTimeout(
        timer
      );

      authListener.subscription.unsubscribe();
    };
  }, [refresh]);

  return {
    identity,

    user:
      identity?.authUser ||
      null,

    authUser:
      identity?.authUser ||
      null,

    profile:
      identity?.profile ||
      null,

    role:
      identity?.role ||
      "",

    displayName:
      identity?.displayName ||
      "",

    email:
      identity?.email ||
      "",

    avatarUrl:
      identity?.avatarUrl ||
      "",

    loading,
    error,

    isAdmin: Boolean(
      identity?.role === "admin"
    ),

    refresh,
    refreshProfile: refresh,
  };
}