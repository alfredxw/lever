import {
  WorkingCopies,
  type ScopeTab,
} from "@/features/worktrees/WorkingCopies";
import { useWorktreeSetup } from "@/features/worktrees/WorktreeSetup";
import {
  copyKey,
  useWorkingCopyOptions,
  worktreeOptionsKey,
} from "@/features/worktrees/queries";
import { useTranslation } from "react-i18next";
import { lazy, Suspense, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import {
  FolderOpen,
  Folder,
  FolderPlus,
  Ellipsis,
  ExternalLink,
  Plus,
  Trash2,
  Save,
  Terminal,
  Archive,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { isMyGo, runtime } from "mygo-runtime";
import { toast } from "sonner";
import type { Agent } from "@/api/types.gen";
import { api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorNotice, Loading } from "@/components/common";
import { ModelCatalogUnavailable } from "@/features/runtime/ModelCatalogUnavailable";
import {
  modelDescription,
  modelSearchAliases,
} from "@/features/runtime/modelLabels";
import {
  resetModelPreferences,
  resetPermissionPreference,
} from "@/features/runtime/runtimePreferences";
import { PermissionOptions } from "@/features/runtime/Permissions";
import {
  usePermissionMapping,
  type PermissionSource,
} from "@/features/runtime/permissionMapping";
import {
  refreshModels,
  useModels,
  useProviders,
} from "@/features/runtime/queries";
import { directoryName, displayPath } from "@/lib/paths";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { connectionName } from "@/features/runtime/connections";
import { ProfileSkills } from "@/features/skills/ProfileSkills";
import { ScopeSkillSources } from "@/features/skills/ScopeSkillSources";
import { DisabledSkills } from "@/features/skills/DisabledSkills";
import { useSkillSources } from "@/features/skills/skillsQuery";

import { AgentAvatar } from "./AgentAvatar";
import { CreateAgentOptions } from "./CreateAgentOptions";
import { defaultAvatar } from "./avatarPalette";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
const AvatarPicker = lazy(() => import("./AvatarPicker"));

function WorktreeSetupFields({
  agentId,
  formId,
  commands,
  onChange,
}: {
  agentId: string;
  formId: string;
  commands: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [requestId] = useState(() => crypto.randomUUID());
  const options = useWorkingCopyOptions(agentId, requestId);
  if (options.isPending) return <Loading />;
  if (options.error)
    return (
      <ErrorNotice error={options.error} retry={() => void options.refetch()} />
    );
  const repositories = [
    ...new Map(
      options.data.groups.map((group) => [group.gitDir, group]),
    ).values(),
  ];
  if (!repositories.length)
    return (
      <p className="text-sm text-muted-foreground">
        {t("worktrees.noRepository")}
      </p>
    );
  return (
    <FieldGroup className="mt-2 gap-3">
      {repositories.map((repo) => (
        <Field key={repo.gitDir}>
          <label className="grid gap-2">
            <span className="text-sm font-medium" title={repo.source}>
              {directoryName(repo.source)}
            </span>
            <Input
              form={formId}
              aria-label={t("worktrees.setupFor", {
                name: directoryName(repo.source),
              })}
              placeholder="pnpm install --frozen-lockfile"
              value={commands[repo.gitDir] ?? ""}
              maxLength={4096}
              onChange={(event) =>
                onChange({ ...commands, [repo.gitDir]: event.target.value })
              }
            />
          </label>
        </Field>
      ))}
    </FieldGroup>
  );
}

function newAgentDraft(
  homeDir: string,
  defaultAgent?: Agent,
  source?: Agent,
  copySuffix = "",
): Agent {
  const defaults = defaultAgent?.profile;
  const defaultPath = defaults?.roots.find(
    ({ id }) => id === defaults.primaryRootId,
  )?.path;
  const profile = source?.profile;
  const sourceRoots = profile?.roots.length
    ? profile.roots
    : [{ id: "", path: defaultPath || homeDir || "~" }];
  const roots = sourceRoots.map(({ path }) => ({
    id: crypto.randomUUID(),
    path,
  }));
  const primaryIndex = sourceRoots.findIndex(
    ({ id }) => id === profile?.primaryRootId,
  );
  let name = source?.name ?? "";
  if (source) {
    const suffix = ` ${copySuffix}`;
    const characters = Array.from(name);
    const encoder = new TextEncoder();
    while (name && encoder.encode(name + suffix).length > 100) {
      characters.pop();
      name = characters.join("");
    }
    name = name.trimEnd() + suffix;
  }
  return {
    id: "",
    name,
    avatar: source?.avatar ?? defaultAvatar,
    archived: false,
    createdAt: "",
    updatedAt: "",
    profile: {
      instructions: "",
      provider: "",
      model: "",
      permission: "",
      ...profile,
      roots,
      primaryRootId: (roots[primaryIndex] ?? roots[0]).id,
      skills: profile?.skills ?? [],
      delegations: profile?.delegations ?? [],
    },
  };
}

function rebaseProfileDraft(draft: Agent, previous: Agent, latest: Agent) {
  const contents = ({ updatedAt, archived, profile, ...identity }: Agent) => {
    const { disabledSkills, ...settings } = profile;
    return JSON.stringify({ identity, settings });
  };
  if (contents(previous) !== contents(latest)) return latest;

  const before = new Set(
    previous.profile.disabledSkills?.map((name) => name.toLowerCase()),
  );
  const edited = draft.profile.disabledSkills ?? [];
  const editedNames = new Set(edited.map((name) => name.toLowerCase()));
  const saved = latest.profile.disabledSkills ?? [];
  const savedNames = new Set(saved.map((name) => name.toLowerCase()));
  const disabledSkills = saved.filter(
    (name) =>
      !before.has(name.toLowerCase()) || editedNames.has(name.toLowerCase()),
  );
  disabledSkills.push(
    ...edited.filter(
      (name) =>
        !before.has(name.toLowerCase()) && !savedNames.has(name.toLowerCase()),
    ),
  );
  return {
    ...draft,
    archived: latest.archived,
    updatedAt: latest.updatedAt,
    profile: { ...draft.profile, disabledSkills },
  };
}

type ProfileCreation = {
  defaultAgent?: Agent;
  source?: Agent;
  onSave: (agent: Agent) => void;
};

export function Profile({
  agent: existingAgent,
  creation,
  agents,
  homeDir,
}: {
  agents: Agent[];
  homeDir: string;
} & (
  | { agent: Agent; creation?: never }
  | { agent?: never; creation: ProfileCreation }
)) {
  const { t } = useTranslation();
  const scopeId = useId();
  const formId = `${scopeId}-profile`;
  const providers = useProviders();
  const selectCopyName = useRef(!!creation?.source);
  const nameInput = useRef<HTMLInputElement>(null);
  const creationBody = useRef<HTMLDivElement>(null);
  const focusNameAfterSourceChange = useRef(false);
  const [createMode, setCreateMode] = useState<"new" | "copy">(
    creation?.source ? "copy" : "new",
  );
  const [permissionSources, setPermissionSources] = useState<
    Partial<Record<typeof createMode, PermissionSource>>
  >({});
  const permissionSource = permissionSources[createMode];
  function setPermissionSource(source?: PermissionSource) {
    setPermissionSources((current) => ({ ...current, [createMode]: source }));
  }
  const copyMode = createMode === "copy";
  const copyFrom = (source: Agent) => ({
    sourceId: source.id,
    draft: newAgentDraft(
      homeDir,
      creation?.defaultAgent,
      source,
      t("agents.copySuffix"),
    ),
  });
  const [copy, setCopy] = useState(() =>
    creation?.source ? copyFrom(creation.source) : undefined,
  );
  const [savedProfile, setSavedProfile] = useState(
    () => existingAgent ?? newAgentDraft(homeDir, creation?.defaultAgent),
  );
  const agent = existingAgent ?? savedProfile;
  const creating = !existingAgent;
  // Keep optional fields mounted for form validation after their first use.
  const [moreOptions, setMoreOptions] = useState<boolean>();
  const showOptions = !creating || !!moreOptions;
  const setup = useWorktreeSetup(agent.id);
  const [scopeTab, setScopeTab] = useState<ScopeTab>(
    setup.batch?.kind ?? "directories",
  );
  const [baseDraft, setBaseDraft] = useState(savedProfile);
  const draft = (copyMode && copy?.draft) || baseDraft;
  const hasDraft = !copyMode || !!copy;
  const updateDraft = (update: (current: Agent) => Agent) => {
    if (copyMode) {
      setCopy(
        (current) => current && { ...current, draft: update(current.draft) },
      );
    } else {
      setBaseDraft(update);
    }
  };
  const [enteringPath, setEnteringPath] = useState(false);
  const [editingRoot, setEditingRoot] = useState<string>();
  if (savedProfile.updatedAt !== agent.updatedAt) {
    setSavedProfile(agent);
    // Sidebar archive actions and Skills toggles can be saved while this form is open.
    setBaseDraft((current) => rebaseProfileDraft(current, savedProfile, agent));
  }
  const p = draft.profile;
  const available =
    providers.data?.filter((runtime) => runtime.available) ?? [];
  if (creating && hasDraft && !p.provider && available.length) {
    const preferred =
      available.find(
        (runtime) => runtime.id === creation?.defaultAgent?.profile.provider,
      ) ??
      available.find((runtime) => runtime.installed) ??
      available[0];
    updateDraft((current) => ({
      ...current,
      profile: { ...current.profile, provider: preferred.id },
    }));
  }
  const delegations = p.delegations ?? [];
  const cwd = p.roots.find((root) => root.id === p.primaryRootId)?.path ?? "";
  const catalog = useModels(
    p.provider,
    cwd,
    hasDraft &&
      !!p.provider &&
      (!creating || (!!cwd.trim() && editingRoot !== p.primaryRootId)),
  );
  const mapped = usePermissionMapping(
    permissionSource,
    p.provider,
    cwd,
    catalog.data,
  );
  const permission =
    p.permission || mapped.permission || catalog.data?.defaultPermission || "";
  const profileToSave =
    mapped.permission && !p.permission
      ? { ...draft, profile: { ...p, permission: mapped.permission } }
      : draft;
  const models = catalog.data?.models ?? [];
  const selectedModel = models.find((model) => model.id === p.model);
  const hiddenModels = providers.data?.find(
    ({ id }) => id === p.provider,
  )?.hiddenModels;
  const refresh = () => {
    void refreshModels(p.provider, cwd).catch(() => {});
  };
  const desktop = isMyGo();
  const change = (profile: Partial<Agent["profile"]>) =>
    updateDraft((d) => ({ ...d, profile: { ...d.profile, ...profile } }));
  const setDirectory = (id: string, path: string) =>
    change({
      roots: p.roots.map((root) => (root.id === id ? { ...root, path } : root)),
    });
  const addDirectories = (paths: string[]) => {
    if (!paths.length) return;
    const added = [...new Set(paths)].filter(
      (path) => !p.roots.some((root) => root.path === path),
    );
    if (!added.length) {
      toast.info(t("profile.directoryAlreadyAdded"));
      return;
    }
    // Reuse an edited row's ID when the picker fills its cleared path.
    const roots = p.roots.map((root) => {
      const path = root.path.trim() ? undefined : added.shift();
      return path ? { ...root, path } : root;
    });
    roots.push(...added.map((path) => ({ id: crypto.randomUUID(), path })));
    change({ roots, primaryRootId: p.primaryRootId || roots[0].id });
  };
  const pickDirectory = useMutation({
    mutationFn: (rootId?: string) => {
      const path =
        p.roots.find((root) => root.id === rootId)?.path || cwd || homeDir;
      return Dialogs.pickDirectories(path === "~" ? homeDir : path, !rootId);
    },
    onSuccess: (paths, rootId) => {
      if (!rootId) return addDirectories(paths);
      const [path] = paths;
      if (!path) return;
      if (p.roots.some((root) => root.id !== rootId && root.path === path)) {
        toast.info(t("profile.directoryAlreadyAdded"));
        return;
      }
      setDirectory(rootId, path);
    },
    onError: (error) =>
      toast.error(t("profile.directoryPickerError"), {
        description: error.message,
      }),
  });
  const openDirectory = useMutation({
    mutationFn: Dialogs.openDirectory,
    onError: (error) =>
      toast.error(t("profile.directoryOpenError"), {
        description: error.message,
      }),
  });
  const save = useMutation({
    mutationFn: (value: Agent) =>
      existingAgent
        ? api<Agent>(`/agents/${existingAgent.id}`, value, "PUT")
        : api<Agent>("/agents", value, "POST"),
    onSuccess: (saved) => {
      setPermissionSource();
      if (agent.id) {
        const providerChanged =
          agent.profile.provider !== saved.profile.provider;
        if (providerChanged || agent.profile.model !== saved.profile.model)
          resetModelPreferences(saved.id);
        if (
          providerChanged ||
          agent.profile.permission !== saved.profile.permission
        )
          resetPermissionPreference(saved.id, saved.profile.provider);
      }
      if (existingAgent) setBaseDraft(saved);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({ queryKey: copyKey(saved.id) });
      void queryClient.invalidateQueries({
        queryKey: worktreeOptionsKey(saved.id),
      });
      creation?.onSave(saved);
      toast.success(t("profile.saved"));
    },
  });
  const installed = providers.data?.find(
    (provider) => provider.id === p.provider,
  );
  const supportsSkills = installed?.capabilities.skills === true;
  const skillSources = useSkillSources(
    p.provider,
    { roots: p.roots, primaryRootId: p.primaryRootId },
    hasDraft && supportsSkills && showOptions,
  );
  const collaborators = showOptions
    ? agents.filter(
        (target) =>
          target.id !== agent.id &&
          (!target.archived ||
            delegations.some(({ agentId }) => agentId === target.id)),
      )
    : [];
  const savedScope = JSON.stringify([
    agent.profile.primaryRootId,
    agent.profile.roots,
  ]);
  const directoriesChanged =
    savedScope !== JSON.stringify([p.primaryRootId, p.roots]);
  const emptyScope = p.roots.length === 0;
  const choosePrimary = !creating || p.roots.length > 1;
  const busy = pickDirectory.isPending || save.isPending;
  const canSave =
    !busy &&
    !mapped.pending &&
    hasDraft &&
    !emptyScope &&
    (!creating ||
      (!!draft.name.trim() &&
        !!installed?.available &&
        p.roots.every((root) => root.path.trim())));
  const openDirectoryLabel = t(
    desktop && runtime().platform === "darwin"
      ? "profile.openInFinder"
      : "profile.openDirectory",
  );
  const pathRows = p.roots.map((root) => {
    const actions = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("profile.directoryActions", {
              path: displayPath(root.path, homeDir),
            })}
            disabled={busy}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max">
          {desktop && root.path.trim() && (
            <DropdownMenuItem
              disabled={openDirectory.isPending}
              onSelect={() => openDirectory.mutate(root.path)}
            >
              <ExternalLink />
              {openDirectoryLabel}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              const roots = p.roots.filter((r) => r.id !== root.id);
              change({
                roots,
                primaryRootId:
                  p.primaryRootId === root.id
                    ? (roots[0]?.id ?? "")
                    : p.primaryRootId,
              });
            }}
          >
            <Trash2 />
            {t("profile.removeDirectory")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    return (
      <Field
        key={root.id}
        orientation="horizontal"
        className="profile-path-row"
        data-disabled={busy}
      >
        {choosePrimary && (
          <RadioGroupItem
            aria-label={t("profile.defaultDirectory", {
              path: displayPath(root.path, homeDir),
            })}
            value={root.id}
          />
        )}
        <InputGroup>
          <InputGroupAddon>
            <Folder />
          </InputGroupAddon>
          <InputGroupInput
            id={`${scopeId}-root-${root.id}`}
            form={formId}
            onInvalid={() => {
              // Reveal the field in time for the browser to focus it.
              if (scopeTab !== "directories")
                flushSync(() => setScopeTab("directories"));
            }}
            aria-label={t("profile.scopeDirectory")}
            placeholder="~/path/to/workspace"
            title={root.path}
            value={creating ? root.path : displayPath(root.path, homeDir)}
            disabled={busy}
            onFocus={creating ? () => setEditingRoot(root.id) : undefined}
            onBlur={creating ? () => setEditingRoot(undefined) : undefined}
            onChange={(event) => setDirectory(root.id, event.target.value)}
            required
            pattern=".*\S.*"
          />
          {creating && (
            <InputGroupAddon align="inline-end">
              {desktop && (
                <InputGroupButton
                  size="icon-xs"
                  aria-label={t("profile.chooseDirectory")}
                  title={t("profile.chooseDirectory")}
                  disabled={busy}
                  onClick={() => pickDirectory.mutate(root.id)}
                >
                  <FolderOpen />
                </InputGroupButton>
              )}
              {actions}
            </InputGroupAddon>
          )}
        </InputGroup>
        {!creating && actions}
      </Field>
    );
  });
  const directoryActions = (
    <div className="flex flex-wrap items-center gap-2">
      {desktop && (
        <Button
          type="button"
          variant={emptyScope ? "default" : "ghost"}
          size={emptyScope ? "default" : "sm"}
          disabled={busy}
          onClick={() => pickDirectory.mutate(undefined)}
        >
          {emptyScope ? (
            <FolderOpen data-icon="inline-start" />
          ) : (
            <FolderPlus data-icon="inline-start" />
          )}
          {t(emptyScope ? "profile.chooseDirectory" : "profile.addDirectory")}
        </Button>
      )}
      {(!desktop || emptyScope) && (
        <Popover open={enteringPath} onOpenChange={setEnteringPath}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant={!desktop && emptyScope ? "default" : "ghost"}
              size="sm"
              disabled={busy}
            >
              {!desktop && <FolderPlus data-icon="inline-start" />}
              {t(
                emptyScope
                  ? "profile.enterDirectoryPath"
                  : "profile.addDirectory",
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 max-w-[calc(100vw-1.5rem)] p-3"
            aria-label={t("profile.enterDirectoryPath")}
          >
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const path = new FormData(event.currentTarget).get("path");
                if (typeof path !== "string" || !path.trim()) return;
                addDirectories([path]);
                setEnteringPath(false);
              }}
            >
              <FieldLabel htmlFor={`${scopeId}-path`}>
                {t("profile.enterDirectoryPath")}
              </FieldLabel>
              <Input
                id={`${scopeId}-path`}
                name="path"
                placeholder="~/path/to/workspace"
                required
                pattern=".*\S.*"
              />
              <Button type="submit" size="sm" className="justify-self-end">
                {t("profile.addDirectory")}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
  const directories = (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      {!creating && (
        <div
          className={
            emptyScope
              ? "grid justify-items-start gap-2"
              : "flex flex-wrap items-center justify-between gap-2"
          }
        >
          <p id={`${scopeId}-scope-hint`} className="profile-note">
            {t(emptyScope ? "profile.emptyScopeHint" : "profile.scopeHint")}
          </p>
          {directoryActions}
        </div>
      )}
      {creating && p.roots.length > 1 && (
        <p id={`${scopeId}-scope-hint`} className="profile-note">
          {t("profile.scopeHint")}
        </p>
      )}
      {!emptyScope && choosePrimary ? (
        <RadioGroup
          aria-labelledby={`${scopeId}-scope`}
          aria-describedby={`${scopeId}-scope-hint`}
          name={`${scopeId}-primary-root`}
          value={p.primaryRootId}
          disabled={busy}
          onValueChange={(primaryRootId) => change({ primaryRootId })}
        >
          {pathRows}
        </RadioGroup>
      ) : (
        pathRows
      )}
      {!creating && supportsSkills && (
        <ScopeSkillSources sources={skillSources} homeDir={homeDir} />
      )}
    </div>
  );
  const scopeCard = !creating && (
    <Card className="profile-card profile-wide gap-3">
      <CardHeader>
        <CardTitle id={`${scopeId}-scope`}>{t("profile.scope")}</CardTitle>
      </CardHeader>
      <CardContent>
        {agent.updatedAt ? (
          <Tabs
            value={scopeTab}
            onValueChange={(value) => setScopeTab(value as ScopeTab)}
            className="gap-3"
          >
            <div className="overflow-x-auto border-b">
              <TabsList
                variant="line"
                className="px-0"
                aria-labelledby={`${scopeId}-scope`}
              >
                <TabsTrigger
                  value="directories"
                  className="px-2 group-data-horizontal/tabs:after:bottom-[-3px]"
                >
                  {t("profile.directories")}
                </TabsTrigger>
                <TabsTrigger
                  value="group"
                  className="px-2 group-data-horizontal/tabs:after:bottom-[-3px]"
                >
                  {t("worktrees.groups")}
                </TabsTrigger>
                <TabsTrigger
                  value="worktree"
                  className="px-2 group-data-horizontal/tabs:after:bottom-[-3px]"
                >
                  {t("worktrees.worktrees")}
                </TabsTrigger>
              </TabsList>
            </div>
            {scopeTab !== "directories" && directoriesChanged && (
              <p className="text-xs text-muted-foreground" role="status">
                {t("worktrees.unsavedScope")}
              </p>
            )}
            <TabsContent
              value="directories"
              forceMount
              hidden={scopeTab !== "directories"}
            >
              {directories}
            </TabsContent>
            <WorkingCopies
              key={savedScope}
              agentId={agent.id}
              tab={scopeTab}
              canCreate={!agent.archived}
              setup={setup}
              setupFields={
                !draft.archived && (
                  <Collapsible className="border-t pt-2">
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="group"
                      >
                        <ChevronDown className="group-data-[state=closed]:-rotate-90" />
                        {t("worktrees.setupCommands")}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-2">
                      <WorktreeSetupFields
                        agentId={agent.id}
                        formId={formId}
                        commands={p.worktreeSetup ?? {}}
                        onChange={(worktreeSetup) => change({ worktreeSetup })}
                      />
                    </CollapsibleContent>
                  </Collapsible>
                )
              }
            />
          </Tabs>
        ) : (
          directories
        )}
      </CardContent>
    </Card>
  );
  const avatarPicker = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="profile-avatar-trigger"
          aria-label={t("agents.editAvatar")}
          title={t("agents.editAvatar")}
        >
          <AgentAvatar agent={draft} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-(--radix-popover-content-available-height) w-[min(340px,calc(100vw-32px))] overflow-y-auto p-4"
        align="start"
        aria-label={t("agents.editAvatar")}
      >
        <Suspense fallback={<Loading />}>
          <AvatarPicker
            agent={draft}
            onChange={(avatar) =>
              updateDraft((current) => ({ ...current, avatar }))
            }
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
  const NameInput = creating ? InputGroupInput : Input;
  const nameControl = (
    <NameInput
      id={`${scopeId}-name`}
      ref={nameInput}
      form={formId}
      autoFocus={creating && !focusNameAfterSourceChange.current}
      onFocus={(event) => {
        if (selectCopyName.current) {
          selectCopyName.current = false;
          event.currentTarget.select();
        }
      }}
      placeholder={t("profile.namePlaceholder")}
      value={draft.name}
      onChange={(e) => {
        const name = e.target.value;
        updateDraft((current) => ({ ...current, name }));
      }}
      required
      maxLength={100}
    />
  );
  const nameField = (
    <Field className="profile-name">
      <FieldLabel htmlFor={`${scopeId}-name`}>{t("profile.name")}</FieldLabel>
      {creating ? (
        <InputGroup className="agent-create-name-control">
          <InputGroupAddon>{avatarPicker}</InputGroupAddon>
          {nameControl}
        </InputGroup>
      ) : (
        nameControl
      )}
    </Field>
  );
  const sourceField = copyMode && (
    <Field className="agent-create-source">
      <FieldLabel htmlFor={`${scopeId}-copy-source`}>
        {t("agents.copySource")}
      </FieldLabel>
      <SearchableSelect
        id={`${scopeId}-copy-source`}
        label={t("agents.copySource")}
        placeholder={t("agents.chooseCopySource")}
        searchLabel={t("agents.searchCopySource")}
        emptyLabel={t("agents.noCopySources")}
        value={copy?.sourceId}
        disabled={busy}
        defaultOpen={!hasDraft}
        options={agents.map((source) => ({
          id: source.id,
          label: source.name,
          icon: <AgentAvatar agent={source} size="sm" />,
        }))}
        onChange={(id) => {
          const source = agents.find((agent) => agent.id === id);
          if (!source) return;
          focusNameAfterSourceChange.current = true;
          save.reset();
          setPermissionSource();
          setCopy(copyFrom(source));
        }}
        onCloseAutoFocus={(event) => {
          if (!focusNameAfterSourceChange.current) return;
          focusNameAfterSourceChange.current = false;
          event.preventDefault();
          nameInput.current?.focus({ preventScroll: true });
          nameInput.current?.select();
        }}
      />
    </Field>
  );
  const providerField = (
    <Field>
      <FieldLabel htmlFor={`${scopeId}-provider`}>
        {t("profile.provider")}
      </FieldLabel>
      <Select
        value={p.provider}
        disabled={creating && !available.length}
        onValueChange={(provider) => {
          if (provider === p.provider) return;
          setPermissionSource(
            permissionSource ??
              (p.provider ? { provider: p.provider, permission } : undefined),
          );
          change({ provider, model: "", permission: "" });
        }}
      >
        <SelectTrigger
          id={`${scopeId}-provider`}
          aria-label={t("profile.provider")}
          className="w-full"
        >
          <SelectValue
            placeholder={t(
              providers.isPending ? "common.loading" : "channels.chooseRuntime",
            )}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {providers.data?.map((provider) => (
              <SelectItem
                key={provider.id}
                value={provider.id}
                disabled={!provider.available}
              >
                <RuntimeIcon provider={provider} />
                {connectionName(provider, providers.data ?? [], t)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {creating && providers.error && (
        <ErrorNotice
          error={providers.error}
          retry={() => void providers.refetch()}
        />
      )}
      {creating && providers.data && !available.length && (
        <p className="profile-note">{t("channels.enableRuntime")}</p>
      )}
      {creating &&
        p.provider &&
        !!available.length &&
        !installed?.available && (
          <p className="profile-note">{t("profile.chooseAvailableRuntime")}</p>
        )}
    </Field>
  );
  const instructionsId = `${scopeId}-instructions`;
  const instructionsInput = (
    <Textarea
      id={instructionsId}
      form={formId}
      rows={creating ? 2 : 9}
      placeholder={t("profile.instructionsPlaceholder")}
      value={p.instructions}
      onChange={(e) => change({ instructions: e.target.value })}
    />
  );
  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("models.refresh")}
      title={t("models.refresh")}
      disabled={catalog.isFetching || !p.provider}
      onClick={refresh}
    >
      <RefreshCw className={catalog.isFetching ? "animate-spin" : undefined} />
    </Button>
  );
  const modelLabel = (
    <FieldLabel htmlFor={`${scopeId}-model`}>{t("profile.model")}</FieldLabel>
  );
  const runtimeFields = (
    <>
      {providerField}
      <Field>
        {creating ? (
          <div className="agent-create-field-heading">
            {modelLabel}
            {refreshButton}
          </div>
        ) : (
          modelLabel
        )}
        <div className="profile-model-picker">
          <SearchableSelect
            key={p.provider}
            id={`${scopeId}-model`}
            label={t("profile.model")}
            placeholder={t("profile.defaultModel")}
            searchLabel={t("models.search")}
            emptyLabel={t("models.noMatches")}
            className="flex-1"
            value={p.model ?? ""}
            currentLabel={selectedModel?.name}
            onChange={(model) => change({ model })}
            options={[
              { id: "", label: t("profile.defaultModel") },
              ...(p.model && !selectedModel
                ? [{ id: p.model, label: p.model, disabled: true }]
                : []),
              ...models
                .filter(({ id }) => id !== "" && !hiddenModels?.includes(id))
                .map((model) => ({
                  id: model.id,
                  label: model.name,
                  keywords: modelSearchAliases(model),
                  description: modelDescription(
                    t,
                    model,
                    installed?.name ?? p.provider,
                  ),
                  disabled: !!model.requiresVersion,
                })),
            ]}
          />
          {!creating && refreshButton}
        </div>
        {catalog.isLoading && (
          <p className="profile-note">{t("common.loading")}</p>
        )}
        {catalog.error ? (
          <ErrorNotice error={catalog.error} retry={refresh} />
        ) : (
          catalog.data === null && (
            <ModelCatalogUnavailable
              retry={refresh}
              disabled={catalog.isFetching}
            />
          )
        )}
      </Field>
      <PermissionOptions
        providerType={installed?.type}
        permissions={catalog.data?.permissions}
        legacyPermissions={catalog.data?.legacyPermissions}
        value={permission}
        onChange={(permission) => {
          setPermissionSource();
          change({ permission });
        }}
      />
    </>
  );
  const runtimeCard = !creating && (
    <Card className="profile-card profile-runtime">
      <CardHeader>
        <CardTitle>{t("profile.runtime")}</CardTitle>
        <CardDescription>{t("profile.runtimeHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>{runtimeFields}</FieldGroup>
        {installed?.installed && catalog.data !== null && (
          <p
            className="profile-runtime-status profile-note"
            title={installed.path}
          >
            <Terminal aria-hidden="true" />
            {installed.version}
          </p>
        )}
      </CardContent>
    </Card>
  );
  const disabledSkills = (
    <DisabledSkills
      names={p.disabledSkills ?? []}
      attached={p.skills ?? []}
      sources={skillSources}
      supported={supportsSkills}
      onChange={(disabledSkills) => change({ disabledSkills })}
    />
  );
  const additionalSkills = (
    <ProfileSkills
      paths={p.skills ?? []}
      homeDir={homeDir}
      onChange={(skills) => change({ skills })}
    />
  );
  const queueFields = (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${scopeId}-task-concurrency`}>
          {t("profile.taskConcurrency")}
        </FieldLabel>
        <Input
          id={`${scopeId}-task-concurrency`}
          form={formId}
          type="number"
          min={1}
          step={1}
          placeholder="1"
          value={p.taskConcurrency || ""}
          onChange={(event) =>
            change({
              taskConcurrency: event.target.valueAsNumber || undefined,
            })
          }
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${scopeId}-task-interval`}>
          {t("profile.taskStartInterval")}
        </FieldLabel>
        <Input
          id={`${scopeId}-task-interval`}
          form={formId}
          type="number"
          min={0}
          step={1}
          placeholder={t("profile.taskStartUnlimited")}
          value={p.taskStartIntervalMinutes || ""}
          onChange={(event) =>
            change({
              taskStartIntervalMinutes: event.target.valueAsNumber || undefined,
            })
          }
        />
      </Field>
    </FieldGroup>
  );
  const delegationFields =
    collaborators.length === 0 ? (
      <Empty className="profile-empty">
        <EmptyDescription>{t("profile.delegationsHint")}</EmptyDescription>
      </Empty>
    ) : (
      <FieldGroup className="profile-delegations">
        {collaborators.map((target) => {
          const rule = delegations.find((d) => d.agentId === target.id);
          return (
            <Field
              key={target.id}
              orientation="horizontal"
              className="profile-delegation"
            >
              <Checkbox
                id={`${scopeId}-delegate-${target.id}`}
                checked={!!rule}
                onCheckedChange={(checked) =>
                  change({
                    delegations: checked
                      ? [...delegations, { agentId: target.id, confirm: true }]
                      : delegations.filter((d) => d.agentId !== target.id),
                  })
                }
              />
              <FieldLabel
                htmlFor={`${scopeId}-delegate-${target.id}`}
                className="profile-collaborator"
              >
                <AgentAvatar agent={target} />
                <span className="truncate" title={target.name}>
                  {target.name}
                  {target.archived && ` (${t("common.archived")})`}
                </span>
              </FieldLabel>
              {rule && (
                <label className="profile-confirm">
                  <Switch
                    size="sm"
                    disabled={target.archived}
                    checked={rule.confirm}
                    onCheckedChange={(confirm) =>
                      change({
                        delegations: delegations.map((d) =>
                          d.agentId === target.id ? { ...d, confirm } : d,
                        ),
                      })
                    }
                  />
                  {t("profile.confirm")}
                </label>
              )}
            </Field>
          );
        })}
      </FieldGroup>
    );
  return (
    <div className={creating ? "agent-create-form" : "profile-form"}>
      {/* Inline Scope editors own their own form submissions. */}
      <form
        id={formId}
        hidden
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate(profileToSave);
        }}
      />
      {creation ? (
        <>
          <DialogHeader className="agent-create-header">
            <DialogTitle>
              {t(copyMode ? "agents.duplicate" : "agents.create")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("agents.description")}
            </DialogDescription>
            <ToggleGroup
              type="single"
              className="agent-create-modes"
              aria-label={t("agents.creationMode")}
              value={createMode}
              spacing={1}
              disabled={busy}
              onValueChange={(value) => {
                if (value !== "new" && value !== "copy") return;
                save.reset();
                setCreateMode(value);
                creationBody.current?.scrollTo(0, 0);
              }}
            >
              <ToggleGroupItem value="new">{t("agents.new")}</ToggleGroupItem>
              <ToggleGroupItem value="copy" disabled={!agents.length}>
                {t("agents.fromExisting")}
              </ToggleGroupItem>
            </ToggleGroup>
          </DialogHeader>
          <div className="agent-create-body" ref={creationBody}>
            {sourceField}
            {hasDraft && (
              <>
                <div className="agent-create-basics">
                  <section
                    className="agent-create-section"
                    aria-labelledby={`${scopeId}-details`}
                  >
                    <h3 id={`${scopeId}-details`}>
                      {t("profile.agentDetails")}
                    </h3>
                    {nameField}
                    <Field>
                      <div className="agent-create-field-heading">
                        <FieldLabel
                          id={`${scopeId}-scope`}
                          htmlFor={`${scopeId}-root-${p.primaryRootId}`}
                        >
                          {t("profile.scope")}
                        </FieldLabel>
                        {directoryActions}
                      </div>
                      {directories}
                    </Field>
                    <Field className="agent-create-role">
                      <FieldLabel htmlFor={instructionsId}>
                        {t("profile.roleOptional")}
                      </FieldLabel>
                      {instructionsInput}
                    </Field>
                  </section>
                  <section
                    className="agent-create-section"
                    aria-labelledby={`${scopeId}-runtime`}
                  >
                    <h3 id={`${scopeId}-runtime`}>{t("profile.runtime")}</h3>
                    {runtimeFields}
                  </section>
                </div>
                <CreateAgentOptions
                  open={moreOptions}
                  onOpenChange={setMoreOptions}
                  skills={
                    <>
                      {supportsSkills && (
                        <ScopeSkillSources
                          fullWidth
                          sources={skillSources}
                          homeDir={homeDir}
                        />
                      )}
                      {additionalSkills}
                      {disabledSkills}
                    </>
                  }
                  queue={queueFields}
                  delegations={delegationFields}
                />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <h2 className="profile-heading">{t("profile.title")}</h2>
          <Card className="profile-card">
            <CardContent className="profile-identity">
              {avatarPicker}
              {nameField}
            </CardContent>
          </Card>
          <div className="profile-grid">
            <Card className="profile-card profile-instructions">
              <CardHeader>
                <CardTitle>
                  <label htmlFor={instructionsId}>
                    {t("profile.instructions")}
                  </label>
                </CardTitle>
              </CardHeader>
              <CardContent>{instructionsInput}</CardContent>
            </Card>
            {runtimeCard}
            {scopeCard}
            {disabledSkills}
            {additionalSkills}
            <Card className="profile-card">
              <CardHeader>
                <CardTitle>{t("profile.taskQueue")}</CardTitle>
              </CardHeader>
              <CardContent>{queueFields}</CardContent>
            </Card>
            <Card className="profile-card">
              <CardHeader>
                <CardTitle>{t("profile.delegations")}</CardTitle>
              </CardHeader>
              <CardContent>{delegationFields}</CardContent>
            </Card>
          </div>
        </>
      )}
      <footer className="profile-actions">
        {save.error && <ErrorNotice error={save.error} />}
        {creating ? (
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              {t("common.cancel")}
            </Button>
          </DialogClose>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-muted-foreground"
            title={t("profile.archiveHint")}
            onClick={() =>
              save.mutate({ ...profileToSave, archived: !draft.archived })
            }
            disabled={emptyScope || busy || mapped.pending}
          >
            <Archive data-icon="inline-start" />
            {draft.archived ? t("profile.restore") : t("profile.archive")}
          </Button>
        )}
        <Button type="submit" form={formId} disabled={!canSave}>
          {!creating && <Save data-icon="inline-start" />}
          {t(
            save.isPending
              ? "profile.saving"
              : creation
                ? copyMode
                  ? "agents.createCopy"
                  : "agents.create"
                : "profile.save",
          )}
        </Button>
      </footer>
    </div>
  );
}
