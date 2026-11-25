import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Provider } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isAntigravityCLIAuthRequired,
  modelsQuery,
  refreshModels,
} from "@/features/runtime/queries";

const TerminalPane = lazy(() => import("@/features/terminal/TerminalPane"));

function closeTerminal(path: string) {
  return api(path, {}, "DELETE");
}

export function useProviderLogin(visible: boolean) {
  const { t } = useTranslation();
  const [terminal, setTerminal] = useState<{
    id: string;
    path: string;
    provider: Provider;
  }>();
  const active = useRef<string>(undefined);
  const start = useMutation({
    mutationFn: async (path: string) => {
      await api(path, {}, "POST");
      if (active.current !== path) await closeTerminal(path);
    },
  });
  const verify = useMutation({
    mutationFn: async ({ id, code }: { id: string; code: number }) => {
      if (code !== 0) throw new Error(t("antigravity.cliLoginFailed"));
      // The host clears its catalog before reporting exit 0. Drop any web
      // request that started before then so verification uses that fresh catalog.
      await queryClient.cancelQueries({
        queryKey: modelsQuery(id).queryKey,
        exact: true,
      });
      const catalog = await refreshModels(id);
      if (
        !catalog ||
        catalog.provisional ||
        !catalog.models.some(({ id }) => id)
      )
        throw new Error(t("antigravity.cliLoginVerificationFailed"));
    },
    onSuccess: (_, { id }) => refresh(id),
  });
  useEffect(
    () => () => {
      const path = active.current;
      active.current = undefined;
      if (path) void closeTerminal(path).catch(() => {});
    },
    [],
  );

  function open(provider: Provider) {
    if (active.current) return;
    verify.reset();
    const id = crypto.randomUUID();
    const path = `/providers/${encodeURIComponent(provider.id)}/terminal/${id}`;
    active.current = path;
    setTerminal({ id, path, provider });
    start.mutate(path);
  }

  function refresh(id: string) {
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models", id] });
  }

  function close() {
    const path = active.current;
    active.current = undefined;
    setTerminal(undefined);
    if (path) {
      void closeTerminal(path).then(
        () => {
          if (terminal && terminal.provider.type !== "antigravity")
            refresh(terminal.provider.id);
        },
        (error: Error) => {
          toast.error(error.message);
        },
      );
    }
  }

  useEffect(() => {
    if (!visible && active.current) {
      const path = active.current;
      active.current = undefined;
      setTerminal(undefined);
      void closeTerminal(path).catch(() => {});
    }
  }, [visible]);

  const agy = terminal?.provider.type === "antigravity";
  return {
    open,
    dialog: terminal && visible && (
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t("providers.loginTitle", { name: terminal.provider.name })}
            </DialogTitle>
            <DialogDescription>
              {t(
                agy
                  ? "antigravity.cliLoginHint"
                  : terminal.provider.type === "pi"
                    ? "providers.piLoginHint"
                    : "providers.loginHint",
              )}
            </DialogDescription>
          </DialogHeader>
          {start.error && <ErrorNotice error={start.error} />}
          {!start.error && (
            <div className="relative h-[min(21rem,45dvh)] overflow-hidden rounded-md border bg-background">
              {start.isPending ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <Suspense fallback={<Skeleton className="h-full w-full" />}>
                  <TerminalPane
                    key={terminal.id}
                    path={terminal.path}
                    terminalId={terminal.id}
                    style={{ inset: 0 }}
                    started
                    closing={false}
                    selected={false}
                    onResult={(result) => {
                      if (
                        result.type !== "exited" ||
                        active.current !== terminal.path
                      )
                        return;
                      if (agy)
                        verify.mutate({
                          id: terminal.provider.id,
                          code: result.code,
                        });
                      else if (result.code === 0) refresh(terminal.provider.id);
                    }}
                  />
                </Suspense>
              )}
            </div>
          )}
          {agy && (verify.isPending || verify.isSuccess) && (
            <p role="status" className="text-sm text-muted-foreground">
              {t(
                verify.isPending
                  ? "antigravity.cliLoginVerifying"
                  : "antigravity.phase.authenticated",
              )}
            </p>
          )}
          {agy && verify.error && (
            <ErrorNotice
              error={
                isAntigravityCLIAuthRequired(verify.error)
                  ? t("antigravity.cliLoginNotPersisted")
                  : verify.error
              }
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}
