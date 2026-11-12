import { useCallback, useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 640px)";

export function useMediaQuery(condition: string) {
  const subscribe = useCallback((callback: () => void) => {
    const query = window.matchMedia?.(condition);
    query?.addEventListener("change", callback);
    return () => query?.removeEventListener("change", callback);
  }, [condition]);
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(condition).matches ?? false, () => false);
}

/** Width, rather than user-agent or input type, determines the record layout. */
export function usePhoneLayout() {
  return useMediaQuery(PHONE_QUERY);
}
