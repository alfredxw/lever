import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createAutoSaver,
  type AutoSaveMode,
  type AutoSaveOptions,
} from "@/lib/autoSave";

export function useAutoSave<T, R>(options: AutoSaveOptions<T, R>) {
  const [saver] = useState(() => createAutoSaver(options));

  useLayoutEffect(() => {
    saver.updateOptions({
      debounceMs: options.debounceMs,
      save: options.save,
      onSaved: options.onSaved,
      onError: options.onError,
      rebase: options.rebase,
    });
  });

  useEffect(() => {
    saver.mount();
    return () => saver.dispose();
  }, [saver]);

  const state = useSyncExternalStore(saver.subscribe, saver.getState);

  return {
    ...state,
    syncSaved: saver.syncSaved,
    schedule: (value: T, signature: string, mode: AutoSaveMode) =>
      saver.schedule(value, signature, mode),
    cancelPending: saver.cancelPending,
    flush: saver.flush,
    retry: saver.retry,
  };
}
