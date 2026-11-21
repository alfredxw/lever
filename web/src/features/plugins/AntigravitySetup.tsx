import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, LogIn } from "lucide-react";
import { api, queryClient } from "@/api/client";
import type { ProviderInfo, ProviderSetup } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/features/settings/SettingsControls";

const busy = (phase?: string) =>
  ["installing", "signing_in", "cancelling"].includes(phase ?? "");

export function AntigravitySetup({ provider }: { provider: ProviderInfo }) {
  const { t } = useTranslation();
  const keyId = useId();
  const [apiKey, setApiKey] = useState("");
  const usesKey =
    provider.authMethod === "gemini-api-key" ||
    provider.authMethod === "agent-platform";
  const saveKey = useMutation({
    mutationFn: (key: string) =>
      api(
        `/providers/${encodeURIComponent(provider.id)}/api-key`,
        { key },
        "PUT",
      ),
    onSuccess: () => {
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["models", provider.id] });
    },
  });
  const key = ["provider-setup", provider.id];
  const setup = useQuery({
    queryKey: key,
    queryFn: () => api<ProviderSetup>(`/providers/${provider.id}/setup`),
    refetchInterval: (query) => (busy(query.state.data?.phase) ? 1000 : false),
  });
  const action = useMutation({
    mutationFn: (action: string) =>
      api<ProviderSetup>(`/providers/${provider.id}/setup`, { action }),
    onSuccess: (state) => queryClient.setQueryData(key, state),
  });
  const phase = setup.data?.phase ?? "idle";
  const pending = busy(phase);
  useEffect(() => {
    if (phase === "installed" || phase === "authenticated") {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["models", provider.id] });
    }
  }, [phase, provider.id]);

  return (
    <div className="flex flex-col gap-3">
      <SettingsRow
        title={t("settings.authentication")}
        description={t(
          usesKey ? "providers.apiKeyHint" : "antigravity.accountHint",
        )}
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!provider.installed && !provider.command && (
            <Button
              variant="outline"
              size="sm"
              disabled={!provider.available || pending || action.isPending}
              onClick={() => action.mutate("install")}
            >
              <Download data-icon="inline-start" />
              {t("antigravity.install")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={
              !provider.installed ||
              !provider.available ||
              pending ||
              action.isPending
            }
            onClick={() => action.mutate("signin")}
          >
            <LogIn data-icon="inline-start" />
            {t(usesKey ? "providers.checkAccess" : "antigravity.signin")}
          </Button>
          {pending && (
            <Button
              variant="ghost"
              size="sm"
              disabled={action.isPending || phase === "cancelling"}
              onClick={() => action.mutate("cancel")}
            >
              {t("common.cancel")}
            </Button>
          )}
        </div>
      </SettingsRow>
      {usesKey && (
        <SettingsRow id={keyId} title={t("providers.apiKey")}>
          <Input
            id={keyId}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            disabled={saveKey.isPending}
            placeholder={provider.hasApiKey ? "••••••••" : undefined}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={saveKey.isPending || !apiKey.trim()}
            onClick={() => saveKey.mutate(apiKey.trim())}
          >
            {t("common.save")}
          </Button>
          {provider.hasApiKey && (
            <Button
              variant="ghost"
              size="sm"
              disabled={saveKey.isPending}
              onClick={() => saveKey.mutate("")}
            >
              {t("common.remove")}
            </Button>
          )}
        </SettingsRow>
      )}
      {saveKey.error && <ErrorNotice error={saveKey.error} />}
      <div role="status" className="text-sm text-muted-foreground">
        {t(`antigravity.phase.${phase}`)}
      </div>
      {phase === "signing_in" && setup.data?.url && (
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href={setup.data.url} target="_blank" rel="noreferrer">
            <ExternalLink data-icon="inline-start" />
            {t("antigravity.openSignin")}
          </a>
        </Button>
      )}
      {setup.data?.error && <ErrorNotice error={new Error(setup.data.error)} />}
      {(action.error || setup.error) && (
        <ErrorNotice error={action.error ?? setup.error!} />
      )}
    </div>
  );
}
