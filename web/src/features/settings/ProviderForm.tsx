import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { api, queryClient } from "@/api/client";
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
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { providerConfiguration } from "@/features/runtime/connections";
import { providersQuery } from "@/features/runtime/queries";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { AutoSaveMode } from "@/lib/autoSave";
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

type MutablePatch = {
  name: string;
  autoCompactWindow?: number;
  idleCompaction?: string;
  nativeTitles?: boolean;
};

function parseAutoCompact(raw: string): { value?: number; valid: boolean } {
  const text = raw.trim();
  if (!text) return { value: undefined, valid: true };
  if (!/^\d+$/.test(text)) return { valid: false };
  const value = Number(text);
  if (value < 100000 || value > 1000000) return { valid: false };
  return { value, valid: true };
}

function mutableSignature(patch: MutablePatch) {
  return JSON.stringify([
    patch.name.trim(),
    patch.autoCompactWindow ?? 0,
    patch.idleCompaction ?? "",
    patch.nativeTitles !== false,
  ]);
}

function existingLaunch(
  existing: ProviderInfo | undefined,
  antigravity: boolean,
  customExecutable?: boolean,
) {
  if (existing && antigravity) {
    return existing.command === "agy"
      ? "cli"
      : existing.command
        ? "custom"
        : "managed";
  }
  return customExecutable ? "custom" : "cli";
}

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
  const [nativeTitles, setNativeTitles] = useState(
    existing?.nativeTitles !== false,
  );
  const [command, setCommand] = useState(
    existing?.command ?? item.command ?? "",
  );
  const [args, setArgs] = useState(existing?.args ?? item.args ?? []);
  const [launch, setLaunch] = useState(() =>
    existingLaunch(existing, antigravity, customExecutable),
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

  const existingRef = useRef(existing);
  useLayoutEffect(() => {
    existingRef.current = existing;
  });
  const existingMutableSig = existing
    ? mutableSignature({
        name: existing.name,
        autoCompactWindow: existing.autoCompactWindow,
        idleCompaction: existing.idleCompaction,
        nativeTitles: existing.nativeTitles,
      })
    : undefined;
  const prevExistingSig = useRef(existingMutableSig);
  const pendingOwnEchoes = useRef<string[]>([]);

  const autoSave = useAutoSave<MutablePatch, Provider>({
    initialSignature: existingMutableSig,
    save: (patch) =>
      api<Provider>("/providers", {
        ...providerConfiguration(existingRef.current!),
        ...patch,
      }),
    onSaved: (saved) => {
      const sig = mutableSignature({
        name: saved.name,
        autoCompactWindow: saved.autoCompactWindow,
        idleCompaction: saved.idleCompaction,
        nativeTitles: saved.nativeTitles,
      });
      if (sig !== prevExistingSig.current) pendingOwnEchoes.current.push(sig);
      queryClient.setQueryData<ProviderInfo[]>(
        providersQuery.queryKey,
        (rows) =>
          rows?.map((row) =>
            row.id === saved.id
              ? {
                  ...row,
                  name: saved.name,
                  autoCompactWindow: saved.autoCompactWindow,
                  idleCompaction: saved.idleCompaction,
                  nativeTitles: saved.nativeTitles,
                }
              : row,
          ),
      );
      void queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
    },
  });

  useEffect(() => {
    if (!existing || !existingMutableSig) return;
    if (existingMutableSig === prevExistingSig.current) return;
    prevExistingSig.current = existingMutableSig;
    const echoIndex = pendingOwnEchoes.current.indexOf(existingMutableSig);
    if (echoIndex !== -1) {
      pendingOwnEchoes.current.splice(0, echoIndex + 1);
      return;
    }
    pendingOwnEchoes.current = [];
    autoSave.syncSaved(existingMutableSig);
    if (!copy && !autoSave.saving && !autoSave.pending && !autoSave.error) {
      setName(existing.name);
      setCompact(existing.autoCompactWindow?.toString() ?? "");
      setIdle(existing.idleCompaction || "default");
      setNativeTitles(existing.nativeTitles !== false);
    }
  }, [
    existing,
    existingMutableSig,
    copy,
    autoSave.saving,
    autoSave.pending,
    autoSave.error,
    autoSave.syncSaved,
  ]);

  const prevCopy = useRef(copy);
  useEffect(() => {
    if (copy) {
      autoSave.cancelPending();
    } else if (prevCopy.current) {
      scheduleMutable({ name, compact, idle, nativeTitles }, "debounced");
    }
    prevCopy.current = copy;
  });

  const parsedCompact = definition?.autoCompactWindow
    ? parseAutoCompact(compact)
    : { value: undefined, valid: true };
  const nameInvalid = !!existing && !copy && !name.trim();
  const compactInvalid = !!existing && !copy && !parsedCompact.valid;

  function scheduleMutable(
    next: {
      name: string;
      compact: string;
      idle: string;
      nativeTitles: boolean;
    },
    mode: AutoSaveMode,
  ) {
    if (!existing || copy) return;
    const trimmedName = next.name.trim();
    const compactResult = definition?.autoCompactWindow
      ? parseAutoCompact(next.compact)
      : { value: undefined, valid: true };
    if (!trimmedName || trimmedName.length > 100 || !compactResult.valid) {
      autoSave.cancelPending();
      return;
    }
    const patch: MutablePatch = {
      name: trimmedName,
      autoCompactWindow: compactResult.value,
      idleCompaction: next.idle === "default" ? undefined : next.idle,
      ...(definition?.nativeTitles
        ? { nativeTitles: next.nativeTitles ? undefined : false }
        : {}),
    };
    autoSave.schedule(patch, mutableSignature(patch), mode);
  }

  function flushOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && existing && !copy) {
      event.preventDefault();
      autoSave.flush();
    }
  }

  function resetIdentity() {
    if (!existing) return;
    setCommand(existing.command ?? item.command ?? "");
    setArgs(existing.args ?? item.args ?? []);
    setLaunch(existingLaunch(existing, antigravity, customExecutable));
    setDirectory(existing.configDir ?? "");
    setShadow(existing.shadowHome ?? "");
    setMethod(existing.authMethod || "oauth-personal");
    setProject(existing.gcpProject ?? "");
    setLocation(existing.gcpLocation ?? "");
    setApiKey("");
    setName(existing.name);
    setCompact(existing.autoCompactWindow?.toString() ?? "");
    setIdle(existing.idleCompaction || "default");
    setNativeTitles(existing.nativeTitles !== false);
    save.reset();
    autoSave.cancelPending();
  }

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
        nativeTitles:
          definition?.nativeTitles && !nativeTitles ? false : undefined,
        authMethod: authMethod || undefined,
        apiKey: initialKey ? apiKey.trim() || undefined : undefined,
        gcpProject: gcpProject || undefined,
        gcpLocation: gcpLocation || undefined,
      }),
    onSuccess: (provider) => onSaved(provider, newProfile),
  });
  const manualSubmit = !existing || copy;
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
        if (!manualSubmit) {
          autoSave.flush();
          return;
        }
        if (name.trim() && !disabled) save.mutate();
      }}
    >
      <SettingsGroup title={t("providers.configuration")}>
        <SettingsRow id={id + "-name"} title={t("connections.name")}>
          <div className="flex w-full flex-col gap-1">
            <Input
              id={id + "-name"}
              required
              maxLength={100}
              value={name}
              placeholder={t("connections.nameExample")}
              disabled={disabled}
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? id + "-name-error" : undefined}
              onChange={(e) => {
                const nextName = e.target.value;
                setName(nextName);
                scheduleMutable(
                  { name: nextName, compact, idle, nativeTitles },
                  "debounced",
                );
              }}
              onBlur={() => autoSave.flush()}
              onKeyDown={flushOnEnter}
            />
            {nameInvalid && (
              <FieldError id={id + "-name-error"} className="text-xs">
                {t("providers.nameRequired")}
              </FieldError>
            )}
          </div>
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
            <div className="flex w-full flex-col gap-1">
              <Input
                id={id + "-compact"}
                type="number"
                min={100000}
                max={1000000}
                step={1}
                value={compact}
                placeholder={t("common.default")}
                disabled={disabled}
                aria-invalid={compactInvalid || undefined}
                aria-describedby={
                  compactInvalid
                    ? `${id}-compact-description ${id}-compact-error`
                    : `${id}-compact-description`
                }
                onChange={(e) => {
                  const nextCompact = e.target.value;
                  setCompact(nextCompact);
                  scheduleMutable(
                    { name, compact: nextCompact, idle, nativeTitles },
                    "debounced",
                  );
                }}
                onBlur={() => autoSave.flush()}
                onKeyDown={flushOnEnter}
              />
              {compactInvalid && (
                <FieldError id={id + "-compact-error"} className="text-xs">
                  {t("providers.invalidAutoCompact")}
                </FieldError>
              )}
            </div>
          </SettingsRow>
        )}
        {definition?.idleCompactionModes && (
          <SettingsChoiceRow
            title={t("providers.idleCompaction")}
            description={t("providers.idleCompactionHint")}
            value={idle}
            onChange={(nextIdle) => {
              setIdle(nextIdle);
              scheduleMutable(
                { name, compact, idle: nextIdle, nativeTitles },
                "immediate",
              );
            }}
            disabled={disabled}
            options={["default", ...definition.idleCompactionModes].map(
              (value) => ({ value, label: t("providers.idle." + value) }),
            )}
          />
        )}
        {definition?.nativeTitles && (
          <SettingsRow
            id={id + "-native-titles"}
            title={t("providers.nativeTitles")}
            description={t("providers.nativeTitlesHint")}
          >
            <Switch
              id={id + "-native-titles"}
              aria-describedby={id + "-native-titles-description"}
              checked={nativeTitles}
              disabled={disabled}
              onCheckedChange={(nextNativeTitles) => {
                setNativeTitles(nextNativeTitles);
                scheduleMutable(
                  { name, compact, idle, nativeTitles: nextNativeTitles },
                  "immediate",
                );
              }}
            />
          </SettingsRow>
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
      {!manualSubmit && !!autoSave.error && (
        <ErrorNotice error={autoSave.error} retry={autoSave.retry} />
      )}
      {!manualSubmit && autoSave.saving && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("common.saving")}
        </p>
      )}
      {manualSubmit && (
        <div className="provider-form-footer">
          {localAction}
          {copy && <p>{t("providers.identity")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {(onClose || copy) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={copy ? resetIdentity : onClose}
              >
                {t("common.cancel")}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={!name.trim() || disabled}>
              {t(
                copy
                  ? "providers.saveAsNew"
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
