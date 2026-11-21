import { useCallback, useLayoutEffect, useRef } from "react";

// Invoke the latest committed handler through a stable function.
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => latest.current(...args), []);
}
