import { useState, useSyncExternalStore } from "react";

export function savedPreference(key: string, fallback: boolean) {
  try {
    const saved = localStorage.getItem(`lever:files:${key}`);
    return saved === null ? fallback : saved === "true";
  } catch {
    return fallback;
  }
}

// All mounted file tabs follow the last explicit source/preview mode choice.
let preview = savedPreference("preview", true);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useFilePreviewMode(initial?: boolean) {
  const [local, setLocal] = useState(initial ?? true);
  const saved = useSyncExternalStore(subscribe, () => preview);
  return [
    initial === undefined ? saved : local,
    (value: boolean) => {
      if (initial !== undefined) {
        setLocal(value);
        return;
      }
      preview = value;
      try {
        localStorage.setItem("lever:files:preview", String(value));
      } catch {
        /* Keep the choice for this session in restricted webviews. */
      }
      listeners.forEach((listener) => listener());
    },
  ] as const;
}
