import { useId, useState, type ReactNode } from "react";
import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink, LogIn } from "lucide-react";
import { api, queryClient } from "@/api/client";
import type { Catalog, Plugin, Provider, ProviderInfo } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AntigravitySetup } from "@/features/plugins/AntigravitySetup";
import { providerConfiguration } from "@/features/runtime/connections";
import { providersQuery } from "@/features/runtime/queries";
import { ProviderModels } from "./ProviderModels";
import { ProviderForm } from "./ProviderForm";
import { SettingsGroup, SettingsRow } from "./SettingsControls";

type Runtime = Pick<Provider, "pluginId" | "type">;
type StatusTone = "detected" | "ready" | "warning" | "error" | "muted";

export type ProviderStatus = { label: string; tone: StatusTone };

export const installationGuides: Record<string, string> = {
  "lever.codex": "https://developers.openai.com/codex/cli",
  "lever.claude": "https://code.claude.com/docs/en/quickstart",
  "lever.antigravity": "https://antigravity.google/docs/cli/getting-started",
  "lever.pi": "https://docs.pi.dev/latest/quickstart",
  "lever.dsh": "https://github.com/deepseek-ai/deepseek-harness#quick-start",
};

export function ProviderMark({
  runtime,
  large,
}: {
  runtime: Runtime;
  large?: boolean;
}) {
  return (
    <span
      className="provider-mark"
      data-large={large || undefined}
      aria-hidden="true"
    >
      <RuntimeIcon provider={runtime} size={large ? 24 : 16} />
    </span>
  );
}

export function ProviderHeading({
  title,
  runtime,
  description,
  children,
}: {
  title: string;
  runtime?: Runtime;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="provider-heading">
      {runtime && <ProviderMark runtime={runtime} large />}
      <div className="provider-heading-text">
        <h2 tabIndex={-1} data-provider-heading>
          {title}
        </h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </header>
  );
}

export function ProviderConnection({
  status,
  description,
  children,
}: {
  status: ProviderStatus;
  description?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section className="provider-section" aria-labelledby={id}>
      <h3 id={id}>{t("connections.connection")}</h3>
      <div className="provider-connection-row panel-surface">
        <div className="provider-connection-status">
          <span className="provider-status-dot" data-tone={status.tone} />
          <div className="min-w-0">
            <div>{t(status.label)}</div>
            {description && <p>{description}</p>}
          </div>
        </div>
        {children && (
          <div className="provider-connection-actions">{children}</div>
        )}
      </div>
    </section>
  );
}

export function InstallGuide({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild size="sm" variant="outline">
      <a href={url} target="_blank" rel="noreferrer">
        {t("providers.installGuide")}
        <ExternalLink data-icon="inline-end" />
      </a>
    </Button>
  );
}

export function providerStatus(
  provider: ProviderInfo,
  catalog?: Catalog | null,
  catalogFailed = false,
): ProviderStatus {
  if (!provider.available) return { label: "plugins.off", tone: "muted" };
  if (!provider.installed)
    return { label: "settings.notInstalled", tone: "muted" };
  if (provider.error)
    return { label: "plugins.status.detectionFailed", tone: "error" };
  if (provider.loginStatus === "signedOut")
    return { label: "connections.signedOut", tone: "warning" };
  if (catalogFailed)
    return { label: "plugins.status.needsSetup", tone: "warning" };
  if (
    provider.loginStatus === "signedIn" ||
    (catalog?.models.length && !catalog.provisional)
  )
    return { label: "connections.ready", tone: "ready" };
  return { label: "plugins.status.detected", tone: "detected" };
}

export function providerSource(provider: ProviderInfo) {
  if (provider.type === "antigravity")
    return provider.auth === "cli"
      ? "connections.localAntigravity"
      : "antigravity.managed";
  if (provider.configDir) return "connections.customProfile";
  if (provider.pluginId === "lever.acp") return "connections.localCommand";
  if (provider.type === "acp" && provider.pluginId !== "lever.dsh")
    return "providers.source.plugin";
  return "connections.localCLI";
}

export function ProviderDetails({
  provider,
  plugin,
  name,
  catalog,
  visible,
  detecting,
  onDetect,
  onRefreshModels,
  onLogin,
  onSpecifyExecutable,
  onUseManaged,
  addingManaged,
  onRemove,
  onSaved,
  onOpenPlugin,
}: {
  provider: ProviderInfo;
  plugin?: Plugin;
  name: string;
  catalog: UseQueryResult<Catalog | null>;
  visible: boolean;
  detecting: boolean;
  onDetect: () => void;
  onRefreshModels: () => void;
  onLogin: () => void;
  onSpecifyExecutable?: () => void;
  onUseManaged: () => void;
  addingManaged: boolean;
  onRemove: () => void;
  onSaved: (provider: Provider, login: boolean) => void;
  onOpenPlugin: () => void;
}) {
  const { t } = useTranslation();
  const item = plugin?.manifest.contributes.providers?.find(
    (item) => item.id === provider.contributionId,
  );
  const install = installationGuides[provider.pluginId];
  const managed = provider.type === "antigravity" && provider.auth !== "cli";
  const status = providerStatus(provider, catalog.data, catalog.isError);
  const signedOut = provider.loginStatus === "signedOut";
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<Provider>("/providers", {
        ...providerConfiguration(provider),
        enabled,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
  });
  const description =
    plugin && !plugin.enabled
      ? t("plugins.disabledHint")
      : provider.available && provider.installed
        ? [
            provider.configPath && !provider.configDir
              ? t("connections.followCLI")
              : undefined,
            provider.version || catalog.data?.version,
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined;

  return (
    <>
      <ProviderHeading
        title={name}
        runtime={provider}
        description={t(providerSource(provider))}
      >
        <label className="provider-enable">
          <span>{t("connections.enable")}</span>
          <Switch
            aria-label={t("providers.enabled", { name: provider.name })}
            checked={provider.enabled}
            disabled={toggle.isPending || !plugin?.enabled}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
          />
        </label>
      </ProviderHeading>

      <ProviderConnection status={status} description={description}>
        {provider.available && !provider.installed && !managed && (
          <>
            {install && <InstallGuide url={install} />}
            {onSpecifyExecutable && (
              <Button size="sm" variant="outline" onClick={onSpecifyExecutable}>
                {t("providers.source.custom")}
              </Button>
            )}
            {provider.type === "antigravity" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={addingManaged}
                onClick={onUseManaged}
              >
                {t("providers.useManagedAntigravity")}
              </Button>
            )}
          </>
        )}
        {provider.canLogin && (
          <Button
            size="sm"
            variant={signedOut ? "default" : "ghost"}
            onClick={onLogin}
          >
            {signedOut && <LogIn data-icon="inline-start" />}
            {t(
              signedOut
                ? "connections.signIn"
                : provider.loginStatus === "signedIn"
                  ? "connections.signInAgain"
                  : "providers.openLogin",
            )}
          </Button>
        )}
      </ProviderConnection>
      {provider.available && managed && visible && (
        <div className="provider-setup panel-surface">
          <AntigravitySetup provider={provider} />
        </div>
      )}
      {provider.available && provider.installed && provider.error && (
        <ErrorNotice
          error={provider.error}
          retry={detecting ? undefined : onDetect}
        />
      )}
      {toggle.error && <ErrorNotice error={toggle.error} />}
      {visible && plugin?.installed && item && (
        <ProviderForm
          key={JSON.stringify([
            provider.id,
            provider.name,
            provider.autoCompactWindow,
            provider.idleCompaction,
          ])}
          plugin={plugin}
          item={item}
          existing={provider}
          defaultName={provider.name}
          onSaved={onSaved}
        />
      )}
      {provider.available && provider.installed && !signedOut && (
        <ProviderModels
          provider={provider}
          catalog={catalog}
          onRefresh={onRefreshModels}
        />
      )}
      {visible && (
        <ProviderActions
          provider={provider}
          plugin={plugin}
          onRemove={onRemove}
          onOpenPlugin={onOpenPlugin}
        />
      )}
    </>
  );
}

function ProviderActions({
  provider,
  plugin,
  onRemove,
  onOpenPlugin,
}: {
  provider: ProviderInfo;
  plugin?: Plugin;
  onRemove: () => void;
  onOpenPlugin: () => void;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      api(`/providers/${encodeURIComponent(provider.id)}`, {}, "DELETE"),
    onSuccess: async () => {
      onRemove();
      await queryClient.invalidateQueries({
        queryKey: providersQuery.queryKey,
      });
    },
  });
  return (
    <SettingsGroup title={t("connections.manage")}>
      {plugin?.installed && (
        <SettingsRow title={plugin.manifest.name}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenPlugin}
          >
            {t("connections.viewPlugin")}
          </Button>
        </SettingsRow>
      )}
      <SettingsRow title={t("connections.remove")}>
        {confirm && (
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              setConfirm(false);
              remove.reset();
            }}
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button
          variant={confirm ? "destructive" : "outline"}
          size="sm"
          disabled={remove.isPending}
          onClick={() => (confirm ? remove.mutate() : setConfirm(true))}
        >
          {t(confirm ? "providers.confirmRemoval" : "common.remove")}
        </Button>
      </SettingsRow>
      {remove.error && <ErrorNotice error={remove.error} />}
    </SettingsGroup>
  );
}
