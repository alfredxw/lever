export type AutoSaveMode = "immediate" | "debounced";

export type AutoSaveState = {
  saving: boolean;
  pending: boolean;
  error: unknown;
};

type Entry<T> = {
  value: T;
  signature: string;
};

type PendingEntry<T> = Entry<T> & {
  ready: boolean;
};

export type AutoSaveOptions<T, R> = {
  initialSignature?: string;
  debounceMs?: number;
  save: (value: T) => Promise<R>;
  onSaved?: (result: R, sent: T, signature: string) => void;
  onError?: (error: unknown, sent: T, signature: string) => void;
  rebase?: (latest: T, result: R, sent: T) => T;
};

type GuardedSaver = {
  flush: () => void;
  hasUnsavedWork: () => boolean;
};

const activeSavers = new Set<GuardedSaver>();

function flushAllActive() {
  for (const saver of activeSavers) saver.flush();
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") flushAllActive();
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  flushAllActive();
  for (const saver of activeSavers) {
    if (saver.hasUnsavedWork()) {
      event.preventDefault();
      event.returnValue = "";
      return;
    }
  }
}

function updateGlobalGuard(saver: GuardedSaver, active: boolean) {
  if (typeof window === "undefined") return;
  const wasEmpty = activeSavers.size === 0;
  if (active) activeSavers.add(saver);
  else activeSavers.delete(saver);
  const isEmpty = activeSavers.size === 0;
  if (wasEmpty && !isEmpty) {
    window.addEventListener("blur", flushAllActive);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);
  } else if (!wasEmpty && isEmpty) {
    window.removeEventListener("blur", flushAllActive);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("beforeunload", handleBeforeUnload);
  }
}

export type AutoSaver<T, R> = {
  getState: () => AutoSaveState;
  subscribe: (listener: () => void) => () => void;
  updateOptions: (options: Partial<AutoSaveOptions<T, R>>) => void;
  syncSaved: (signature: string) => void;
  schedule: (value: T, signature: string, mode: AutoSaveMode) => void;
  cancelPending: () => void;
  flush: () => void;
  retry: () => void;
  mount: () => void;
  dispose: () => void;
};

export function createAutoSaver<T, R>(
  initialOptions: AutoSaveOptions<T, R>,
): AutoSaver<T, R> {
  let opts = { ...initialOptions };
  let savedSignature = initialOptions.initialSignature;
  let inFlight: Entry<T> | null = null;
  let next: PendingEntry<T> | null = null;
  let failed: Entry<T> | null = null;
  let error: unknown = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  let snapshot: AutoSaveState = { saving: false, pending: false, error: null };

  const guard: GuardedSaver = {
    flush: () => flush(),
    hasUnsavedWork: () =>
      inFlight !== null || next !== null || (!disposed && error !== null),
  };

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function emit() {
    const saving = inFlight !== null;
    const pending = next !== null;
    const guardActive = saving || pending || (!disposed && error !== null);
    updateGlobalGuard(guard, guardActive);
    if (
      snapshot.saving === saving &&
      snapshot.pending === pending &&
      snapshot.error === error
    )
      return;
    snapshot = { saving, pending, error };
    if (!disposed) {
      for (const listener of listeners) listener();
    }
  }

  function pump() {
    if (inFlight || !next || !next.ready) return;
    if (next.signature === savedSignature) {
      clearTimer();
      next = null;
      emit();
      return;
    }
    const current: Entry<T> = { value: next.value, signature: next.signature };
    next = null;
    inFlight = current;
    failed = null;
    error = null;
    emit();

    Promise.resolve()
      .then(() => opts.save(current.value))
      .then(
        (result) => {
          savedSignature = current.signature;
          inFlight = null;
          if (next && opts.rebase) {
            next = {
              ...next,
              value: opts.rebase(next.value, result, current.value),
            };
          }
          opts.onSaved?.(result, current.value, current.signature);
          if (next && next.signature === savedSignature) {
            clearTimer();
            next = null;
          }
          emit();
          pump();
        },
        (err: unknown) => {
          inFlight = null;
          opts.onError?.(err, current.value, current.signature);
          if (next) {
            if (next.signature === savedSignature) {
              clearTimer();
              next = null;
            } else if (next.signature === current.signature) {
              clearTimer();
              next = null;
              failed = current;
              error = err;
            }
          } else {
            failed = current;
            error = err;
          }
          emit();
          pump();
        },
      );
  }

  function flush() {
    if (!next) return;
    clearTimer();
    next.ready = true;
    pump();
  }

  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateOptions(partial) {
      opts = { ...opts, ...partial };
    },
    syncSaved(signature) {
      savedSignature = signature;
      if (!inFlight) {
        if (next && next.signature === signature) {
          clearTimer();
          next = null;
        }
        if (failed && failed.signature === signature) {
          failed = null;
          error = null;
        }
      }
      emit();
    },
    schedule(value, signature, mode) {
      if (disposed) return;
      const target = inFlight ? inFlight.signature : savedSignature;
      if (signature === target) {
        clearTimer();
        next = null;
        if (!inFlight) {
          failed = null;
          error = null;
        }
        emit();
        return;
      }
      if (failed && signature === failed.signature) {
        clearTimer();
        next = null;
        emit();
        return;
      }
      failed = null;
      error = null;
      clearTimer();
      if (mode === "immediate") {
        next = { value, signature, ready: true };
        emit();
        pump();
      } else {
        const delay = opts.debounceMs ?? 500;
        next = { value, signature, ready: false };
        emit();
        timer = setTimeout(() => {
          timer = undefined;
          if (next) {
            next.ready = true;
            pump();
          }
        }, delay);
      }
    },
    cancelPending() {
      clearTimer();
      next = null;
      failed = null;
      error = null;
      emit();
    },
    flush,
    retry() {
      if (disposed || inFlight) return;
      if (failed) {
        const entry = failed;
        failed = null;
        error = null;
        next = { ...entry, ready: true };
        emit();
        pump();
      } else if (next) {
        flush();
      }
    },
    mount() {
      disposed = false;
      emit();
    },
    dispose() {
      disposed = true;
      if (next) {
        clearTimer();
        next.ready = true;
        pump();
      }
      emit();
    },
  };
}
