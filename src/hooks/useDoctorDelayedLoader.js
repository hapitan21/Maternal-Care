import { useEffect, useMemo, useState } from "react";

const doctorLoaderDelayMs = 180;

export function useDoctorDelayedLoader(isLoading) {
  const loadingCycle = useMemo(
    () => ({
      isLoading,
      token: Symbol("doctor-delayed-loader"),
    }),
    [isLoading]
  );

  const [visibleToken, setVisibleToken] = useState(null);

  useEffect(() => {
    if (!loadingCycle.isLoading) {
      return undefined;
    }

    const { token } = loadingCycle;

    const timer = window.setTimeout(() => {
      setVisibleToken(token);
    }, doctorLoaderDelayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loadingCycle]);

  return isLoading && visibleToken === loadingCycle.token;
}