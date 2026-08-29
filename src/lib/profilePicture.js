import { supabase } from "./supabaseClient";

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

async function updateCurrentUserAvatar(avatarUrl) {
  const { error } = await supabase.rpc("set_current_user_avatar_url", {
    p_avatar_url: avatarUrl || null,
  });

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

export async function uploadProfilePicture(file) {
  validateProfilePicture(file);

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) throw authError;
  if (!user?.id) {
    throw createProfilePictureError(
      "Please log in again to upload a profile picture.",
      "avatar_not_authenticated"
    );
  }

  const storagePath = `${user.id}/avatar`;
  const { error: uploadError } = await supabase.storage
    .from(profilePictureBucket)
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) throw uploadError;

  const cacheKey = `${Date.now()}`;
  const displayUrl = await getProfilePictureDisplayUrl(storagePath, cacheKey);
  await updateCurrentUserAvatar(displayUrl);
  const result = {
    userId: user.id,
    storedValue: displayUrl,
    displayUrl,
  };

  announceProfilePictureChange(result);
  return result;
}

export async function removeProfilePicture() {
  const current = await loadCurrentProfilePicture();
  const storagePath = `${current.userId}/avatar`;

  await updateCurrentUserAvatar(null);

  const { error: removeError } = await supabase.storage
    .from(profilePictureBucket)
    .remove([storagePath]);

  if (removeError) {
    await updateCurrentUserAvatar(current.storedValue);
    throw removeError;
  }

  const result = {
    userId: current.userId,
    storedValue: "",
    displayUrl: "",
  };

  announceProfilePictureChange(result);
  return result;
}
