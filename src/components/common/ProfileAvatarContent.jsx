import { useState } from "react";

export default function ProfileAvatarContent({ src = "", alt = "", fallback = "" }) {
  const [failedUrl, setFailedUrl] = useState("");

  if (!src || failedUrl === src) {
    return fallback;
  }

  return <img src={src} alt={alt} onError={() => setFailedUrl(src)} />;
}
