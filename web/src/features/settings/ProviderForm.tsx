import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { api } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type {
  Plugin,
  Provider,
  ProviderContribution,
  ProviderInfo,
  ProviderType,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsRow,
} from "./SettingsControls";

const providerTypesQuery = {
  queryKey: ["provider-types"],
  queryFn: () => api<ProviderType[]>("/provider-types"),
  staleTime: Infinity,
};

type FormProps = {
  plugin: Plugin;
  item: ProviderContribution;
  defaultName: string;
  existing?: ProviderInfo;
  customExecutable?: boolean;
  localAction?: ReactNode;
  onSaved: (p: Provider, login: boolean) => void;
  onClose?: () => void;
};

export function ProviderForm(props: FormProps) {
  const types = useQuery(providerTypesQuery);
  if (types.isPending) return <Skeleton className="h-32" />;
  if (types.error)
    return (
      <ErrorNotice error={types.error} retry={() => void types.refetch()} />
    );
  return (
    <ConnectionForm
      {...props}
      definition={types.data.find((type) => type.id === props.item.driver)}
    />
  );
}

function ConnectionForm({
  plugin,
  item,
  existing,
  definition,
  defaultName,
  customExecutable,
  localAction,
  onSaved,
  onClose,
}: FormProps & { definition?: ProviderType }) {
  const { t } = useTranslation();
  const id = useId();
  const profiles = !!definition?.configEnv;
  const nativeLogin = profiles && plugin.builtin;
  const antigravity = item.driver === "antigravity";
  const [profile, setProfile] = useState(customExecutable ? "local" : "new");
  const newProfile = !existing && nativeLogin && profile === "new";
  const useDirectory =
    profiles && (!!existing || !nativeLogin || profile === "directory");
  const [name, setName] = useState(existing?.name ?? defaultName);
  const [directory, setDirectory] = useState(existing?.configDir ?? "");
  const [shadow, setShadow] = useState(existing?.shadowHome ?? "");
  const [compact, setCompact] = useState(
    existing?.autoCompactWindow?.toString() ?? "",
  );
  const [idle, setIdle] = useState(existing?.idleCompaction || "default");
  const [command, setCommand] = useState(
    existing?.command ?? item.command ?? "",
  );
  const [args, setArgs] = useState(existing?.args ?? item.args ?? []);
  const [launch, setLaunch] = useState(
    existing && antigravity
      ? existing.command === "agy"
        ? "cli"
        : existing.command
          ? "custom"
          : "managed"
      : customExecutable
        ? "custom"
        : "cli",
  );
  const [method, setMethod] = useState(
    existing?.authMethod || "oauth-personal",
  );
  const [project, setProject] = useState(existing?.gcpProject ?? "");
  const [location, setLocation] = useState(existing?.gcpLocation ?? "");
  const [apiKey, setApiKey] = useState("");
  const browse = useMutation({
    mutationFn: () => Dialogs.pickDirectories(directory.trim(), false),
    onSuccess: ([path]) => {
      if (path) setDirectory(path);
    },
  });

  const executable =
    antigravity && launch !== "custom"
      ? launch === "cli"
        ? "agy"
        : ""
      : command.trim();
  const authMethods = definition?.authMethods ?? [];
  const managedAuth =
    authMethods.length > 0 &&
    (launch === "managed" ||
      (launch === "custom" &&
        executable !== "" &&
        !/(^|[\\/])(agy|antigravity)(\.exe)?$/i.test(executable)));
  const gcp =
    managedAuth && (method === "oauth-business" || method === "agent-platform");
  const configDir = useDirectory ? directory.trim() : "";
  const shadowHome = definition?.shadowHome && !newProfile ? shadow.trim() : "";
  const authMethod =
    managedAuth &&
    (method !== "oauth-personal" || existing?.authMethod === method)
      ? method
      : "";
  const gcpProject = gcp ? project.trim() : "";
  const gcpLocation = gcp ? location.trim() : "";
  const copy =
    !!existing &&
    (executable !== existing.command ||
      configDir !== (existing.configDir ?? "") ||
      shadowHome !== (existing.shadowHome ?? "") ||
      authMethod !== (existing.authMethod ?? "") ||
      gcpProject !== (existing.gcpProject ?? "") ||
      gcpLocation !== (existing.gcpLocation ?? "") ||
      args.length !== (existing.args?.length ?? 0) ||
      args.some((arg, i) => arg !== existing.args?.[i]));
  const initialKey =
    (!existing || copy) &&
    managedAuth &&
    (method === "gemini-api-key" || method === "agent-platform");
  const dirty =
    !existing ||
    copy ||
    existing.name !== name.trim() ||
    Number(compact) !== (existing.autoCompactWindow ?? 0) ||
    idle !== (existing.idleCompaction || "default");
  const save = useMutation({
    mutationFn: () =>
      api<Provider>("/providers", {
        id: copy ? "" : (existing?.id ?? ""),
        pluginId: plugin.id,
        contributionId: item.id,
        type: item.driver,
        name: name.trim(),
        enabled: copy || (existing?.enabled ?? true),
        command: executable,
        args,
        configDir: configDir || undefined,
        newProfile: newProfile || undefined,
        shadowHome: shadowHome || undefined,
        autoCompactWindow: Number(compact) || undefined,
        idleCompaction: idle === "default" ? undefined : idle,
        authMethod: authMethod || undefined,
        apiKey: initialKey ? apiKey.trim() || undefined : undefined,
        gcpProject: gcpProject || undefined,
        gcpLocation: gcpLocation || undefined,
      }),
    onSuccess: (provider) => onSaved(provider, newProfile),
  });
  const disabled = save.isPending;
  const choice = (
    title: string,
    value: string,
    onChange: (value: string) => void,
    options: [string, string][],
  ) => (
    <SettingsChoiceRow
      title={t(title)}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={options.map(([v, key]) => ({ value: v, label: t(key) }))}
    />
  );

  return (
    <form
      className="provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && dirty && !disabled) save.mutate();
      }}
    >
      <SettingsGroup title={t("providers.configuration")}>
        <SettingsRow id={id + "-name"} title={t("connections.name")}>
          <Input
            id={id + "-name"}
            required
            maxLength={100}
            value={name}
            placeholder={t("connections.nameExample")}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
          />
        </SettingsRow>
        {antigravity &&
          choice("providers.launchSource", launch, setLaunch, [
            ["cli", "connections.localCLI"],
            ["managed", "antigravity.managed"],
            ["custom", "providers.source.custom"],
          ])}
        {(!antigravity || launch === "custom") && (
          <SettingsRow
            id={id + "-command"}
            title={t("settings.executable")}
            description={
              existing?.path && existing.path !== executable
                ? existing.path
                : undefined
            }
          >
            <Input
              id={id + "-command"}
              value={command}
              disabled={disabled}
              readOnly={!plugin.builtin}
              required={item.driver === "acp" || launch === "custom"}
              placeholder={
                item.command ||
                (antigravity
                  ? "agy"
                  : item.driver === "acp"
                    ? "/path/to/acp-agent"
                    : item.driver)
              }
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
            />
          </SettingsRow>
        )}
        {antigravity &&
          launch !== "custom" &&
          existing?.path &&
          executable === existing.command && (
            <SettingsRow title={t("settings.executable")}>
              <code>{existing.path}</code>
            </SettingsRow>
          )}
        {!existing &&
          nativeLogin &&
          choice("settings.authentication", profile, setProfile, [
            ["local", "connections.localDefault"],
            [
              "new",
              item.driver === "pi"
                ? "connections.newDirectory"
                : "connections.newLogin",
            ],
            ["directory", "connections.useDirectory"],
          ])}
        {useDirectory && (
          <SettingsRow
            id={id + "-directory"}
            title={t("providers.configDir")}
            description={t("providers.configDirHint", {
              variable: definition?.configEnv,
            })}
          >
            <Input
              id={id + "-directory"}
              className="min-w-0 flex-1"
              required={!existing && nativeLogin}
              value={directory}
              spellCheck={false}
              disabled={disabled}
              placeholder={
                existing && !existing.shadowHome
                  ? existing.configPath || t("providers.configDirDefault")
                  : t("providers.configDirDefault")
              }
              onChange={(e) => setDirectory(e.target.value)}
            />
            {isMyGo() && (
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label={t("connections.pickDirectory")}
                disabled={disabled || browse.isPending}
                onClick={() => browse.mutate()}
              >
                <FolderOpen />
              </Button>
            )}
          </SettingsRow>
        )}
        {definition?.shadowHome && !newProfile && (
          <SettingsRow
            id={id + "-shadow"}
            title={t("providers.shadowHome")}
            description={t("providers.shadowHomeHint")}
          >
            <Input
              id={id + "-shadow"}
              value={shadow}
              placeholder="~/…"
              spellCheck={false}
              disabled={disabled}
              onChange={(e) => setShadow(e.target.value)}
            />
          </SettingsRow>
        )}
        {definition?.autoCompactWindow && (
          <SettingsRow
            id={id + "-compact"}
            title={t("providers.autoCompact")}
            description={t("providers.autoCompactHint")}
          >
            <Input
              id={id + "-compact"}
              type="number"
              min={100000}
              max={1000000}
              step={1}
              value={compact}
              placeholder={t("common.default")}
              disabled={disabled}
              onChange={(e) => setCompact(e.target.value)}
            />
          </SettingsRow>
        )}
        {definition?.idleCompactionModes && (
          <SettingsChoiceRow
            title={t("providers.idleCompaction")}
            description={t("providers.idleCompactionHint")}
            value={idle}
            onChange={setIdle}
            disabled={disabled}
            options={["default", ...definition.idleCompactionModes].map(
              (value) => ({ value, label: t("providers.idle." + value) }),
            )}
          />
        )}
        {managedAuth &&
          choice(
            "settings.authentication",
            method,
            (next) => {
              setMethod(next);
              setApiKey("");
            },
            authMethods.map((m) => [m, "providers.auth." + m]),
          )}
        {initialKey && (
          <SettingsRow
            id={id + "-api-key"}
            title={t("providers.apiKey")}
            description={t("providers.apiKeyHint")}
          >
            <Input
              id={id + "-api-key"}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={disabled}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </SettingsRow>
        )}
        {gcp && (
          <SettingsRow id={id + "-project"} title={t("providers.gcpProject")}>
            <Input
              id={id + "-project"}
              required={method === "oauth-business"}
              value={project}
              spellCheck={false}
              placeholder="my-project-id"
              disabled={disabled}
              onChange={(e) => setProject(e.target.value)}
            />
          </SettingsRow>
        )}
        {gcp && (
          <SettingsRow id={id + "-location"} title={t("providers.gcpLocation")}>
            <Input
              id={id + "-location"}
              required={method === "oauth-business"}
              value={location}
              spellCheck={false}
              placeholder="us-central1"
              disabled={disabled}
              onChange={(e) => setLocation(e.target.value)}
            />
          </SettingsRow>
        )}
        {definition?.arguments && (
          <SettingsRow title={t("providers.arguments")}>
            <div className="flex w-full flex-col items-start gap-2">
              {args.map((arg, i) => (
                <div key={i} className="flex w-full items-center gap-2">
                  <Input
                    aria-label={t("providers.argument", { index: i + 1 })}
                    value={arg}
                    disabled={disabled}
                    readOnly={!plugin.builtin}
                    spellCheck={false}
                    onChange={(e) =>
                      setArgs(
                        args.map((a, j) => (j === i ? e.target.value : a)),
                      )
                    }
                  />
                  {plugin.builtin && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={t("providers.removeArgument", {
                        index: i + 1,
                      })}
                      onClick={() => setArgs(args.filter((_, j) => i !== j))}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              ))}
              {plugin.builtin && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setArgs([...args, ""])}
                >
                  <Plus data-icon="inline-start" />
                  {t("providers.addArgument")}
                </Button>
              )}
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>
      {browse.error && <ErrorNotice error={browse.error} />}
      {save.error && <ErrorNotice error={save.error} />}
      {(dirty || !existing) && (
        <div className="provider-form-footer">
          {localAction}
          {copy && <p>{t("providers.identity")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {onClose && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={onClose}
              >
                {t("common.cancel")}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={!name.trim() || disabled}>
              {t(
                copy
                  ? "providers.saveAsNew"
                  : existing
                    ? "common.save"
                    : newProfile
                      ? "connections.addAndLogin"
                      : "providers.saveAndDetect",
              )}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
