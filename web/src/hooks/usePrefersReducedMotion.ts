import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const preference = window.matchMedia(query);
const subscribe = (notify: () => void) => {
  preference.addEventListener("change", notify);
  return () => preference.removeEventListener("change", notify);
};

// WebKit can deliver the change event a frame after the preference takes
// effect. A navigation in that frame should already use the new setting.
const snapshot = () => window.matchMedia(query).matches;
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot);
}
