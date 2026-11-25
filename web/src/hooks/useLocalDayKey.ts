import { useSyncExternalStore } from "react";

function localDayKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function msUntilNextLocalMidnight(now = new Date()) {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  // Add a small buffer so timer jitter does not fire before 00:00:00.
  return Math.max(1000, nextMidnight.getTime() - now.getTime() + 100);
}

const listeners = new Set<() => void>();
let timer: number | undefined;
let lastNotifiedDay = localDayKey();

function notifyIfDayChanged() {
  const current = localDayKey();
  if (current === lastNotifiedDay) return;
  lastNotifiedDay = current;
  for (const listener of listeners) listener();
}

function scheduleNextMidnight() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    notifyIfDayChanged();
    if (listeners.size > 0) scheduleNextMidnight();
  }, msUntilNextLocalMidnight());
}

function handleWake() {
  if (document.visibilityState === "hidden") return;
  notifyIfDayChanged();
  if (listeners.size > 0) scheduleNextMidnight();
}

function subscribe(listener: () => void) {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    lastNotifiedDay = localDayKey();
    scheduleNextMidnight();
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("focus", handleWake);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("focus", handleWake);
    }
  };
}

export function useLocalDayKey() {
  return useSyncExternalStore(subscribe, localDayKey);
}
