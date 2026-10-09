import { supabase } from "./supabaseClient";
import { createAuthenticatedMutation } from "./authenticatedMutation";

export const profilePictureBucket = "profile-pictures";
export const profilePictureUpdatedEvent = "profile-picture-updated";

const maximumProfilePictureBytes = 5 * 1024 * 1024;
const allowedProfilePictureTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function createProfilePictureError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isExternalUrl(value) {
  return /^(?:https?:|data:|blob:)/i.test(String(value || "").trim());
}

function normalizeStoragePath(value) {
  const path = String(value || "").trim().replace(/^\/+/, "");
  const bucketPrefix = `${profilePictureBucket}/`;
  return path.startsWith(bucketPrefix) ? path.slice(bucketPrefix.length) : path;
}

function announceProfilePictureChange(detail) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(profilePictureUpdatedEvent, { detail })
    );
  }
}

async function updateCurrentUserAvatar(avatarUrl, scope) {
  await scope.check();
  const { error } = await scope.client.rpc("set_current_user_avatar_url", {
    p_avatar_url: avatarUrl || null,
  });

  await scope.check();
  if (error) throw error;
}

export function validateProfilePicture(file) {
  if (!file) {
    throw createProfilePictureError("Choose an image to upload.", "avatar_file_missing");
  }

  if (!allowedProfilePictureTypes.has(file.type)) {
    throw createProfilePictureError(
      "Use a JPG, PNG, or WebP image.",
      "avatar_file_type"
    );
  }

  if (file.size > maximumProfilePictureBytes) {
    throw createProfilePictureError(
      "The image must be 5 MB or smaller.",
      "avatar_file_size"
    );
  }

  return file;
}

export async function getProfilePictureDisplayUrl(storedValue, cacheKey = "") {
  const value = String(storedValue || "").trim();
  if (!value) return "";
  if (isExternalUrl(value)) return value;

  const storagePath = normalizeStoragePath(value);
  const { data } = supabase.storage
    .from(profilePictureBucket)
    .getPublicUrl(storagePath);

  const publicUrl = data?.publicUrl || "";
  if (!publicUrl || !cacheKey) return publicUrl;

  const separator = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${separator}v=${encodeURIComponent(cacheKey)}`;
}

export async function loadCurrentProfilePicture() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) throw authError;
  if (!user?.id) {
    throw createProfilePictureError(
      "Please log in again to manage your profile picture.",
      "avatar_not_authenticated"
    );
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw profileError;

  const storedValue = profile?.avatar_url || "";
  const displayUrl = await getProfilePictureDisplayUrl(storedValue);

  return { userId: user.id, storedValue, displayUrl };
}

export async function uploadProfilePicture(file, options = {}) {
  validateProfilePicture(file);
  const scope = await createAuthenticatedMutation(supabase, options);
  try {
    await scope.getUser();
    const storagePath = `${scope.userId}/avatar`;
    const { error: uploadError } = await scope.client.storage
      .from(profilePictureBucket)
      .upload(storagePath, file, {
        cacheControl: "3600", contentType: file.type, upsert: true,
      });
    await scope.check();
    if (uploadError) throw uploadError;
    const displayUrl = await getProfilePictureDisplayUrl(storagePath, `${Date.now()}`);
    await updateCurrentUserAvatar(displayUrl, scope);
    const result = { userId: scope.userId, storedValue: displayUrl, displayUrl };
    scope.assertCurrent();
    announceProfilePictureChange(result);
    return result;
  } finally {
    scope.dispose();
  }
}

export async function removeProfilePicture(options = {}) {
  const scope = await createAuthenticatedMutation(supabase, options);
  try {
    await scope.getUser();
    const { data: profile, error } = await scope.client.from("profiles")
      .select("avatar_url").eq("id", scope.userId).maybeSingle();
    await scope.check();
    if (error) throw error;
    const storagePath = `${scope.userId}/avatar`;
    await updateCurrentUserAvatar(null, scope);
    const { error: removeError } = await scope.client.storage
      .from(profilePictureBucket).remove([storagePath]);
    await scope.check();
    if (removeError) {
      // Rollback is also fenced and uses the original session's token.
      await updateCurrentUserAvatar(profile?.avatar_url || null, scope);
      throw removeError;
    }
    const result = { userId: scope.userId, storedValue: "", displayUrl: "" };
    scope.assertCurrent();
    announceProfilePictureChange(result);
    return result;
  } finally {
    scope.dispose();
  }
}
