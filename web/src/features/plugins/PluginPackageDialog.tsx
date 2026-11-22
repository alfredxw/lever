import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FolderOpen } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { api } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type {
  Plugin,
  PluginManifest,
  PluginPreview,
  PluginPreviewInput,
  PluginRelease,
} from "@/api/types.gen";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type PackageAction =
  | { kind: "install" }
  | { kind: "update"; plugin: Plugin; commit: string }
  | { kind: "select" | "rollback"; plugin: Plugin };

export function releaseLabel(release: PluginRelease) {
  return release.version + " · " + release.commit.slice(0, 8);
}

function entries(t: TFunction, manifest?: PluginManifest) {
  const items = new Map<string, string>();
  for (const item of manifest?.contributes.providers ?? []) {
    items.set(
      t("plugins.kind.providers") + " / " + item.id,
      [
        item.name,
        item.driver,
        item.command,
        ...(item.args ?? []).map((arg) => JSON.stringify(arg)),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  for (const item of manifest?.contributes.channels ?? []) {
    items.set(
      t("plugins.kind.channels") + " / " + item.id,
      [item.name, item.driver, item.command].filter(Boolean).join(" · "),
    );
  }
  for (const item of manifest?.contributes.eventSources ?? []) {
    items.set(
      t("plugins.kind.eventSources") + " / " + item.id,
      [item.name, item.driver, item.command].filter(Boolean).join(" · "),
    );
  }
  return items;
}

function PackageReview({
  preview,
  installed,
}: {
  preview: PluginPreview;
  installed?: Plugin;
}) {
  const { t } = useTranslation();
  const before = entries(t, installed?.manifest);
  const after = entries(t, preview.manifest);
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const changes = keys.filter((key) => before.get(key) !== after.get(key));
  const { source } = preview.release;
  return (
    <div className="grid gap-3 text-sm">
      <div>
        <strong>{preview.manifest.name}</strong>
        <div className="break-all text-muted-foreground">
          {preview.manifest.id}
        </div>
        {preview.manifest.description && <p>{preview.manifest.description}</p>}
      </div>
      <div className="grid gap-1">
        <div className="break-all">
          {source.url}
          {source.path && " · " + source.path}
        </div>
        <div className="break-all text-muted-foreground">
          {source.ref} ·{" "}
          {installed?.current && releaseLabel(installed.current) + " → "}
          {releaseLabel(preview.release)}
        </div>
      </div>
      {changes.length ? (
        <ul className="grid gap-2">
          {changes.map((key) => (
            <li key={key} className="grid gap-0.5 break-words">
              <span>
                {t(
                  !after.has(key)
                    ? "plugins.removed"
                    : before.has(key)
                      ? "plugins.changed"
                      : "plugins.added",
                )}{" "}
                · {key}
              </span>
              {before.has(key) && (
                <del className="break-all text-xs text-muted-foreground">
                  {before.get(key)}
                </del>
              )}
              {after.has(key) && (
                <code className="break-all text-xs">{after.get(key)}</code>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("plugins.sameEntries")}</p>
      )}
      {preview.blockers.length > 0 && (
        <ErrorNotice
          error={t("plugins.incompatible", {
            names: preview.blockers.join(", "),
          })}
        />
      )}
    </div>
  );
}

export function PluginPackageDialog({
  action,
  onClose,
  onSaved,
}: {
  action: PackageAction;
  onClose: () => void;
  onSaved: (p: Plugin) => void;
}) {
  const { t } = useTranslation();
  const instance = useId();
  const installed = action.kind === "install" ? undefined : action.plugin;
  const [origin, setOrigin] = useState("git");
  const [url, setURL] = useState(installed?.current?.source.url ?? "");
  const [ref, setRef] = useState(installed?.current?.source.ref ?? "");
  const [path, setPath] = useState(installed?.current?.source.path ?? "");
  const [directory, setDirectory] = useState("");
  const [request, setRequest] = useState<PluginPreviewInput | null>(() =>
    action.kind === "update"
      ? { commit: action.commit, revision: action.plugin.revision }
      : null,
  );
  const preview = useQuery({
    queryKey: ["plugin-preview", instance, installed?.id, request],
    enabled: !!request,
    queryFn: ({ signal }) =>
      api<PluginPreview>(
        installed
          ? "/plugins/" + installed.id + "/preview"
          : "/plugins/preview",
        request,
        "POST",
        signal,
      ),
    gcTime: 0,
    staleTime: "static",
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previewID = preview.data?.id;
  useEffect(
    () => () => {
      if (previewID)
        void api("/plugin-previews/" + previewID, {}, "DELETE").catch(() => {});
    },
    [previewID],
  );

  const save = useMutation({
    mutationFn: () => {
      if (action.kind === "rollback")
        return api<Plugin>("/plugins/" + action.plugin.id + "/rollback", {
          revision: action.plugin.revision,
        });
      if (origin === "local")
        return api<Plugin>("/plugins", { directory: directory.trim() });
      return api<Plugin>("/plugin-previews/" + previewID + "/apply", {});
    },
    onSuccess: onSaved,
  });
  const pick = useMutation({
    mutationFn: () => Dialogs.pickDirectories(directory, false),
    onSuccess: (paths) => {
      if (paths[0]) setDirectory(paths[0]);
    },
  });
  const rollback = action.kind === "rollback";
  const local = origin === "local";
  const reviewing = !!request;
  const submit = () => {
    if (rollback || local || preview.data) {
      save.mutate();
      return;
    }
    if (preview.isError && request) {
      void preview.refetch();
      return;
    }
    setRequest(
      installed
        ? { ref: ref.trim(), revision: installed.revision }
        : { url: url.trim(), ref: ref.trim(), path: path.trim() },
    );
  };
  const title = rollback
    ? "plugins.rollback"
    : action.kind === "install"
      ? "plugins.install"
      : "plugins.reviewUpdate";
  const unavailable = reviewing
    ? preview.isFetching ||
      (!preview.data && !preview.isError) ||
      !!preview.data?.blockers.length
    : local
      ? !directory.trim()
      : !url.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(title)}</DialogTitle>
          <DialogDescription>
            {t(
              rollback
                ? "plugins.rollbackHint"
                : local
                  ? "plugins.installHint"
                  : "plugins.gitHint",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {action.kind === "install" && !reviewing && (
            <ToggleGroup
              type="single"
              value={origin}
              aria-label={t("plugins.filterOrigin")}
              onValueChange={(v) => {
                if (v) {
                  setOrigin(v);
                  save.reset();
                }
              }}
            >
              <ToggleGroupItem value="git">{t("plugins.git")}</ToggleGroupItem>
              <ToggleGroupItem value="local">
                {t("plugins.directory")}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {rollback && installed?.current && installed.previous && (
            <p>
              {releaseLabel(installed.current)} →{" "}
              {releaseLabel(installed.previous)}
            </p>
          )}
          {local && (
            <Field>
              <FieldLabel htmlFor={instance + "dir"}>
                {t("plugins.directory")}
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={instance + "dir"}
                  required
                  value={directory}
                  disabled={save.isPending}
                  onChange={(e) => setDirectory(e.target.value)}
                />
                {isMyGo() && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      size="icon-sm"
                      aria-label={t("plugins.chooseDirectory")}
                      onClick={() => pick.mutate()}
                      disabled={pick.isPending || save.isPending}
                    >
                      <FolderOpen />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
            </Field>
          )}
          {!local && !rollback && !reviewing && (
            <>
              <Field>
                <FieldLabel htmlFor={instance + "url"}>
                  {t("plugins.repository")}
                </FieldLabel>
                <Input
                  id={instance + "url"}
                  required
                  readOnly={!!installed}
                  placeholder="https://… / git@…"
                  value={url}
                  onChange={(e) => setURL(e.target.value)}
                />
              </Field>
              {(!installed || path) && (
                <Field>
                  <FieldLabel htmlFor={instance + "path"}>
                    {t("plugins.subdir")}
                  </FieldLabel>
                  <Input
                    id={instance + "path"}
                    readOnly={!!installed}
                    placeholder={t("plugins.repoRoot")}
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={instance + "ref"}>
                  {t("plugins.ref")}
                </FieldLabel>
                <Input
                  id={instance + "ref"}
                  required={!!installed}
                  placeholder={t("plugins.defaultBranch")}
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </Field>
            </>
          )}
          {reviewing && preview.isFetching && (
            <p role="status">{t("plugins.preparingPreview")}</p>
          )}
          {preview.data && (
            <PackageReview preview={preview.data} installed={installed} />
          )}
          {(preview.error || save.error || pick.error) && (
            <ErrorNotice
              error={save.error ?? preview.error ?? pick.error}
              retry={
                save.isError && previewID
                  ? () => {
                      save.reset();
                      void preview.refetch();
                    }
                  : undefined
              }
            />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            {reviewing && action.kind !== "update" && (
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending}
                onClick={() => {
                  setRequest(null);
                  save.reset();
                }}
              >
                {t("plugins.editSource")}
              </Button>
            )}
            <Button
              type="submit"
              disabled={save.isPending || (!rollback && unavailable)}
            >
              {t(
                rollback
                  ? "plugins.rollback"
                  : preview.data
                    ? installed
                      ? "plugins.applyUpdate"
                      : "plugins.install"
                    : local
                      ? "plugins.install"
                      : "plugins.preview",
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
