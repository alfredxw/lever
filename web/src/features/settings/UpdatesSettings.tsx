import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw, RotateCw } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "./SettingsControls";
import type { DesktopUpdatesController } from "./useDesktopUpdates";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatCheckedTime(raw: string | undefined, locale: string): string {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function displayVersion(version: string): string {
  if (!version || version === "dev") return version || "dev";
  return version.startsWith("v") ? version : `v${version}`;
}

export function UpdatesSettings({
  controller,
}: {
  controller: DesktopUpdatesController;
}) {
  const { t, i18n } = useTranslation();
  const [restarting, setRestarting] = useState(false);
  const { state, actionError } = controller;

  if (!state) {
    return <Loading />;
  }

  const locale = i18n.resolvedLanguage ?? "en-US";
  const checkedTime = formatCheckedTime(state.lastCheckedAt, locale);
  const downloaded = state.downloaded ?? 0;
  const total = state.total ?? 0;
  const percent =
    total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;

  let statusDescription: string;
  if (!state.supported) {
    statusDescription =
      state.disabledReason === "dev"
        ? t("settings.updatesDisabledDev")
        : t("settings.updatesDisabledUnwritable");
  } else {
    switch (state.status) {
      case "checking":
        statusDescription = t("settings.updatesChecking");
        break;
      case "up-to-date":
        statusDescription = checkedTime
          ? t("settings.updatesUpToDateChecked", { time: checkedTime })
          : t("settings.updatesUpToDate");
        break;
      case "available":
        statusDescription = t("settings.updatesAvailable", {
          version: displayVersion(state.version ?? ""),
        });
        break;
      case "downloading":
        statusDescription =
          total > 0
            ? t("settings.updatesDownloadingProgress", {
                version: displayVersion(state.version ?? ""),
                downloaded: formatBytes(downloaded),
                total: formatBytes(total),
                percent,
              })
            : t("settings.updatesDownloading", {
                version: displayVersion(state.version ?? ""),
              });
        break;
      case "installing":
        statusDescription = t("settings.updatesInstalling", {
          version: displayVersion(state.version ?? ""),
        });
        break;
      case "ready":
        statusDescription = t("settings.updatesReady", {
          version: displayVersion(state.version ?? ""),
        });
        break;
      case "error":
        statusDescription = t("settings.updatesErrorHint");
        break;
      default:
        statusDescription = checkedTime
          ? t("settings.updatesLastChecked", { time: checkedTime })
          : t("settings.updatesDescription");
        break;
    }
  }

  const displayError =
    actionError ?? (state.error ? new Error(state.error) : null);

  const showProgress =
    state.status === "downloading" || state.status === "installing";
  const showNotes =
    Boolean(state.notes?.trim()) &&
    Boolean(state.version) &&
    (state.status === "available" ||
      state.status === "downloading" ||
      state.status === "installing" ||
      state.status === "ready");

  async function handleRestart() {
    setRestarting(true);
    try {
      await controller.restartToUpdate();
    } finally {
      setRestarting(false);
    }
  }

  return (
    <>
      <SettingsGroup title={t("settings.updatesVersion")}>
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <span className="tabular-nums">
                Lever {displayVersion(state.currentVersion)}
              </span>
              {state.status === "available" && state.version && (
                <Badge variant="outline" className="tabular-nums">
                  {displayVersion(state.version)}
                </Badge>
              )}
              {state.status === "ready" && state.version && (
                <Badge variant="secondary" className="tabular-nums">
                  {t("settings.updatesReadyBadge", {
                    version: displayVersion(state.version),
                  })}
                </Badge>
              )}
            </span>
          }
          description={statusDescription}
        >
          <div className="settings-inline-actions">
            {state.status === "available" && state.version && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void controller.skipVersion(state.version!)}
                >
                  {t("settings.updatesSkip")}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void controller.download()}
                >
                  <Download data-icon="inline-start" />
                  {t("settings.updatesDownload")}
                </Button>
              </>
            )}
            {state.status === "downloading" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void controller.cancelDownload()}
              >
                {t("common.cancel")}
              </Button>
            )}
            {state.status === "installing" && (
              <Button variant="outline" size="sm" disabled>
                <RefreshCw
                  data-icon="inline-start"
                  className="animate-spin"
                  aria-hidden="true"
                />
                {t("settings.updatesPreparing")}
              </Button>
            )}
            {state.status === "ready" && (
              <Button
                variant="default"
                size="sm"
                disabled={restarting}
                onClick={() => void handleRestart()}
              >
                <RotateCw data-icon="inline-start" />
                {t("settings.updatesRestart")}
              </Button>
            )}
            {state.status === "checking" && (
              <Button variant="outline" size="sm" disabled>
                <RefreshCw
                  data-icon="inline-start"
                  className="animate-spin"
                  aria-hidden="true"
                />
                {t("settings.updatesCheckingAction")}
              </Button>
            )}
            {(state.status === "idle" ||
              state.status === "up-to-date" ||
              state.status === "error") && (
              <>
                {state.status === "error" && state.version && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void controller.download()}
                  >
                    <Download data-icon="inline-start" />
                    {t("settings.updatesRetryDownload")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!state.supported}
                  onClick={() => void controller.check()}
                >
                  <RefreshCw data-icon="inline-start" />
                  {t("settings.updatesCheck")}
                </Button>
              </>
            )}
          </div>
        </SettingsRow>
        {showProgress && (
          <div className="pb-4">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                state.status === "installing" ? 100 : total > 0 ? percent : undefined
              }
            >
              <div
                className={
                  state.status === "installing" || total > 0
                    ? "h-full rounded-full bg-foreground transition-[width] duration-150"
                    : "h-full w-1/3 animate-pulse rounded-full bg-foreground/60"
                }
                style={
                  state.status === "installing"
                    ? { width: "100%" }
                    : total > 0
                      ? { width: `${percent}%` }
                      : undefined
                }
              />
            </div>
          </div>
        )}
      </SettingsGroup>

      {displayError && (
        <ErrorNotice
          error={displayError}
          retry={
            state.supported && state.status === "error"
              ? () =>
                  void (state.version
                    ? controller.download()
                    : controller.check())
              : undefined
          }
        />
      )}

      {showNotes && (
        <SettingsGroup
          title={t("settings.updatesReleaseNotes", {
            version: displayVersion(state.version ?? ""),
          })}
        >
          <div className="max-h-72 overflow-y-auto py-4 text-sm leading-relaxed">
            <MessageResponse mode="static" text={state.notes ?? ""} />
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("settings.updatesPreferences")}>
        <SettingsRow
          id="settings-updates-auto-check"
          title={t("settings.updatesAutoCheck")}
          description={t("settings.updatesAutoCheckDescription")}
        >
          <Switch
            id="settings-updates-auto-check"
            aria-describedby="settings-updates-auto-check-description"
            checked={state.automaticChecks}
            disabled={!state.supported}
            onCheckedChange={(automaticChecks) =>
              void controller.setPreferences({ automaticChecks })
            }
          />
        </SettingsRow>
        <SettingsRow
          id="settings-updates-auto-download"
          title={t("settings.updatesAutoDownload")}
          description={t("settings.updatesAutoDownloadDescription")}
        >
          <Switch
            id="settings-updates-auto-download"
            aria-describedby="settings-updates-auto-download-description"
            checked={state.automaticDownloads}
            disabled={!state.supported}
            onCheckedChange={(automaticDownloads) =>
              void controller.setPreferences({ automaticDownloads })
            }
          />
        </SettingsRow>
        <SettingsRow
          id="settings-updates-prereleases"
          title={t("settings.updatesPrereleases")}
          description={t("settings.updatesPrereleasesDescription")}
        >
          <Switch
            id="settings-updates-prereleases"
            aria-describedby="settings-updates-prereleases-description"
            checked={state.prereleases}
            disabled={!state.supported}
            onCheckedChange={(prereleases) =>
              void controller.setPreferences({ prereleases })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
