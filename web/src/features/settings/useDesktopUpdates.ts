import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import { toast } from "sonner";
import {
  Updates,
  events as desktopEvents,
  type UpdatePreferences,
  type UpdateState,
} from "@/api/desktop.gen";

export type DesktopUpdatesController = {
  state: UpdateState | null;
  hasActionableUpdate: boolean;
  actionError: Error | null;
  clearActionError: () => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  skipVersion: (version: string) => Promise<void>;
  setPreferences: (patch: Partial<UpdatePreferences>) => Promise<void>;
  restartToUpdate: () => Promise<void>;
};

export function isDesktopRestartBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("desktop_restart_busy");
}

export function useDesktopUpdates({
  onOpenUpdates,
  viewingUpdates,
}: {
  onOpenUpdates: () => void;
  viewingUpdates: boolean;
}): DesktopUpdatesController {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const onOpenRef = useRef(onOpenUpdates);
  onOpenRef.current = onOpenUpdates;
  const viewingRef = useRef(viewingUpdates);
  viewingRef.current = viewingUpdates;
  const notifiedReadyRef = useRef<string | null>(null);

  const handleState = useCallback(
    (next: UpdateState) => {
      setState(next);
      if (next.status !== "error") {
        setActionError(null);
      }
      if (
        next.status === "ready" &&
        next.version &&
        notifiedReadyRef.current !== next.version &&
        !viewingRef.current
      ) {
        notifiedReadyRef.current = next.version;
        toast(t("settings.updatesToastReadyTitle", { version: next.version }), {
          id: `desktop-update-ready:${next.version}`,
          description: t("settings.updatesToastReadyDescription"),
          duration: 12_000,
          action: {
            label: t("settings.updatesView"),
            onClick: () => onOpenRef.current(),
          },
        });
      }
    },
    [t],
  );

  useEffect(() => {
    if (!isMyGo()) return;
    let active = true;
    const offState = desktopEvents.leverUpdateState.on((next) => {
      if (active) handleState(next);
    });
    const offOpen = desktopEvents.leverOpenUpdates.on(() => {
      if (active) onOpenRef.current();
    });
    void Updates.state()
      .then((initial) => {
        if (active) setState(initial);
      })
      .catch((error: unknown) =>
        console.warn("Load desktop update state", error),
      );
    void Updates.takeOpenRequest()
      .then((pending) => {
        if (active && pending) onOpenRef.current();
      })
      .catch((error: unknown) =>
        console.warn("Consume open updates request", error),
      );
    return () => {
      active = false;
      offState();
      offOpen();
    };
  }, [handleState]);

  const check = useCallback(async () => {
    if (!isMyGo()) return;
    setActionError(null);
    try {
      const next = await Updates.check();
      setState(next);
    } catch (error) {
      setActionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }, []);

  const download = useCallback(async () => {
    if (!isMyGo()) return;
    setActionError(null);
    try {
      await Updates.download();
    } catch (error) {
      setActionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }, []);

  const cancelDownload = useCallback(async () => {
    if (!isMyGo()) return;
    setActionError(null);
    try {
      const next = await Updates.cancelDownload();
      setState(next);
    } catch (error) {
      setActionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }, []);

  const skipVersion = useCallback(async (version: string) => {
    if (!isMyGo()) return;
    setActionError(null);
    try {
      const next = await Updates.skipVersion(version);
      setState(next);
    } catch (error) {
      setActionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }, []);

  const setPreferences = useCallback(
    async (patch: Partial<UpdatePreferences>) => {
      if (!isMyGo() || !state) return;
      setActionError(null);
      try {
        const next = await Updates.setPreferences({
          automaticChecks: patch.automaticChecks ?? state.automaticChecks,
          automaticDownloads:
            patch.automaticDownloads ?? state.automaticDownloads,
          prereleases: patch.prereleases ?? state.prereleases,
        });
        setState(next);
      } catch (error) {
        setActionError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    [state],
  );

  const restartToUpdate = useCallback(async () => {
    if (!isMyGo()) return;
    setActionError(null);
    try {
      await Updates.restartToUpdate();
    } catch (error) {
      if (isDesktopRestartBusyError(error)) {
        setActionError(new Error(t("settings.updatesRestartBusy")));
        return;
      }
      setActionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }, [t]);

  const hasActionableUpdate =
    state?.status === "available" || state?.status === "ready";

  return {
    state,
    hasActionableUpdate,
    actionError,
    clearActionError: () => setActionError(null),
    check,
    download,
    cancelDownload,
    skipVersion,
    setPreferences,
    restartToUpdate,
  };
}
