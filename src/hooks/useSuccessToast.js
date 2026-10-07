import { useCallback, useRef, useState } from "react";

export function useSuccessToast() {
  const [toast, setToast] = useState(null);
  const sequence = useRef(0);
  const dismissToast = useCallback(() => setToast(null), []);
  const showSuccessToast = useCallback((content) => {
    sequence.current += 1;
    setToast({ ...content, id: sequence.current });
  }, []);
  return { toast, showSuccessToast, dismissToast };
}
