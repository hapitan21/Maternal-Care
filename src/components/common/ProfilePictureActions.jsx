import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import {
  removeProfilePicture,
  uploadProfilePicture,
} from "../../lib/profilePicture";
import "../../styles/profile-picture-actions.css";

export default function ProfilePictureActions({
  avatarUrl = "",
  disabled = false,
  onChange,
  expectedUserId = "",
}) {
  const mountedRef = useRef(false);
  const abortRef = useRef(null);
  const pendingRef = useRef(false);
  const ownerRef = useRef(expectedUserId);
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    ownerRef.current = expectedUserId;
    return () => { mountedRef.current = false; controller.abort(); };
  }, [expectedUserId]);
  const actionsRef = useRef(null);
  const inputRef = useRef(null);
  const triggerRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [message, setMessage] = useState("");
  const busy = Boolean(busyAction);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnOutsideClick = (event) => {
      if (actionsRef.current && !actionsRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };

    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const choosePhoto = () => {
    setMessage("");
    setMenuOpen(false);
    inputRef.current?.click();
  };

  const runPhotoAction = async (action) => {
    if (pendingRef.current || disabled || !mountedRef.current) return;
    pendingRef.current = true;
    const owner = expectedUserId;
    const isCurrent = () => mountedRef.current && ownerRef.current === owner;
    try {
      setBusyAction(action.type);
      setMessage("");
      setMenuOpen(false);
      const result = await action.run({ expectedUserId: owner, isCurrent, signal: abortRef.current?.signal });
      if (isCurrent()) onChange?.(result.displayUrl, result.storedValue);
    } catch (error) {
      if (isCurrent()) setMessage(error?.message || "Unable to update the photo.");
    } finally {
      pendingRef.current = false;
      if (isCurrent()) setBusyAction("");
    }
  };

  const handleUpload = event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    return runPhotoAction({ type: "upload", run: options => uploadProfilePicture(file, options) });
  };

  const handleRemove = () => runPhotoAction({ type: "remove", run: removeProfilePicture });

  return (
    <div className="profile-picture-actions" ref={actionsRef}>
      <input
        ref={inputRef}
        className="profile-picture-actions__input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleUpload}
        disabled={disabled || busy}
      />

      <button
        ref={triggerRef}
        type="button"
        className="profile-picture-actions__trigger"
        title="Edit Photo"
        aria-label="Edit profile photo"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="profile-picture-actions-menu"
        aria-busy={busy}
        onClick={() => setMenuOpen((open) => !open)}
        disabled={disabled || busy}
      >
        <Icon
          className={busy ? "is-spinning" : ""}
          icon={busy ? "solar:refresh-circle-bold-duotone" : "solar:camera-add-bold-duotone"}
          aria-hidden="true"
        />
      </button>

      {menuOpen ? (
        <div
          id="profile-picture-actions-menu"
          className="profile-picture-actions__menu"
          role="menu"
          aria-label="Profile photo actions"
        >
          <button
            type="button"
            role="menuitem"
            onClick={choosePhoto}
            disabled={busy}
          >
            <Icon icon="solar:gallery-add-linear" aria-hidden="true" />
            Choose Photo
          </button>

          {avatarUrl ? (
            <button
              type="button"
              role="menuitem"
              className="profile-picture-actions__remove"
              onClick={handleRemove}
              disabled={busy}
            >
              <Icon icon="solar:trash-bin-minimalistic-linear" aria-hidden="true" />
              Remove Photo
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <span className="profile-picture-actions__error" role="alert">
          {message}
        </span>
      ) : null}
    </div>
  );
}
