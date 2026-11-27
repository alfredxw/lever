import {
  WorkingCopies,
  type ScopeTab,
} from "@/features/worktrees/WorkingCopies";
import {
  useWorktreeSetup,
  WorktreeSetupFields,
} from "@/features/worktrees/WorktreeSetup";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { copyKey, worktreeOptionsKey } from "@/features/worktrees/queries";
import { useTranslation } from "react-i18next";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  FolderOpen,
  Folder,
  FolderPlus,
  Ellipsis,
  ExternalLink,
  Monitor,
  Trash2,
  Archive,
  ChevronDown,
} from "lucide-react";
import { isMyGo, runtime } from "mygo-runtime";
import { toast } from "sonner";
import type {
  Agent,
  DelegationPolicy,
  Overview,
  Project,
} from "@/api/types.gen";
import { api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import {
  AGENT_PERMISSION_POLICIES,
  normalizeAgentPermissionPolicy,
  type AgentPermissionPolicy,
} from "@/features/runtime/permissionMapping";
import { useProviders } from "@/features/runtime/queries";
import { displayPath } from "@/lib/paths";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { connectionName } from "@/features/runtime/connections";
import { ProfileSkills } from "@/features/skills/ProfileSkills";
import { ScopeSkillSources } from "@/features/skills/ScopeSkillSources";
import { DisabledSkills } from "@/features/skills/DisabledSkills";
import { useSkillSources } from "@/features/skills/skillsQuery";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { AutoSaveMode } from "@/lib/autoSave";

import { AgentAvatar } from "./AgentAvatar";
import { CreateAgentOptions } from "./CreateAgentOptions";
import { defaultAvatar } from "./avatarPalette";
import {
  allowsRemoteDelegation,
  canAcceptDelegations,
  defaultDelegationSettings,
  effectiveDelegationPolicy,
  useDelegationSettings,
  useRemoteDelegationTargets,
} from "./delegationPolicy";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
const AvatarPicker = lazy(() => import("./AvatarPicker"));

function profileContentSignature(agent: Agent, homeDir: string) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = agent;
  const worktreeSetup = Object.fromEntries(
    Object.entries(rest.profile.worktreeSetup ?? {})
      .map(([repo, cmd]) => [repo, cmd.trim()] as const)
      .filter(([, cmd]) => cmd !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({
    ...rest,
    name: rest.name.trim(),
    profile: {
      ...rest.profile,
      description: (rest.profile.description ?? "").trim(),
      roots: rest.profile.roots.map((root) => ({
        id: root.id,
        path: displayPath(root.path.trim(), homeDir),
      })),
      skills: rest.profile.skills ?? [],
      disabledSkills: rest.profile.disabledSkills ?? [],
      delegationPolicy: rest.profile.delegationPolicy || "",
      acceptDelegations: rest.profile.acceptDelegations !== false,
      allowRemoteDelegation: rest.profile.allowRemoteDelegation !== false,
      delegations: (rest.profile.delegations ?? []).map((rule) => ({
        deviceId: rule.deviceId || "",
        agentId: rule.agentId,
        confirm: !!rule.confirm,
      })),
      taskConcurrency: rest.profile.taskConcurrency || 0,
      taskStartIntervalMinutes: rest.profile.taskStartIntervalMinutes || 0,
      taskQueuePaused: !!rest.profile.taskQueuePaused,
      worktreeSetup,
    },
  });
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
    const {
      provider,
      model,
      effort,
      fast,
      disabledSkills,
      taskConcurrency,
      taskStartIntervalMinutes,
      taskQueuePaused,
      ...settings
    } = profile;
    void provider;
    void model;
    void effort;
    void fast;
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
    profile: {
      ...draft.profile,
      provider: latest.profile.provider,
      model: latest.profile.model,
      effort: latest.profile.effort,
      fast: latest.profile.fast,
      disabledSkills,
      taskConcurrency: latest.profile.taskConcurrency,
      taskStartIntervalMinutes: latest.profile.taskStartIntervalMinutes,
      taskQueuePaused: latest.profile.taskQueuePaused,
    },
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
  projects = [],
  homeDir,
}: {
  agents: Agent[];
  projects?: Project[];
  homeDir: string;
} & (
  | { agent: Agent; creation?: never }
  | { agent?: never; creation: ProfileCreation }
)) {
  const { t } = useTranslation();
  const [projectDialog, setProjectDialog] = useState<"create" | "edit" | null>(
    null,
  );
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
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
  });
  const globalPermissionMode =
    overviewQuery.data?.permissionSettings?.defaultMode ?? "auto";
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
  const [baseDraft, setBaseDraft] = useState(savedProfile);
  const draft = (copyMode && copy?.draft) || baseDraft;
  const hasDraft = !copyMode || !!copy;
  const linkedProject = draft.profile.projectId
    ? projects.find((item) => item.id === draft.profile.projectId)
    : undefined;
  const worktreeOwner = linkedProject ? "project" : "agent";
  const worktreeOwnerId = linkedProject ? linkedProject.id : agent.id;
  const setup = useWorktreeSetup(worktreeOwnerId, worktreeOwner);
  const [scopeTab, setScopeTab] = useState<ScopeTab>(
    setup.batch?.kind ?? "directories",
  );
  const pendingModeRef = useRef<AutoSaveMode>("immediate");
  const dirtyByUserRef = useRef(false);
  const seenUpdatedAts = useRef(
    new Set(existingAgent ? [existingAgent.updatedAt] : []),
  );
  const prevSavedRef = useRef(savedProfile);

  const updateDraft = (
    update: (current: Agent) => Agent,
    mode: AutoSaveMode = "immediate",
  ) => {
    if (!creating) {
      pendingModeRef.current = mode;
      dirtyByUserRef.current = true;
    }
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
  const p = draft.profile;
  const available =
    providers.data?.filter((runtime) => runtime.available) ?? [];
  const delegations = p.delegations ?? [];
  const cwd = p.roots.find((root) => root.id === p.primaryRootId)?.path ?? "";
  const previewProviderId =
    p.provider ||
    available.find(
      (runtime) => runtime.id === overviewQuery.data?.lastSelection?.provider,
    )?.id ||
    available.find(
      (runtime) => runtime.id === creation?.defaultAgent?.profile.provider,
    )?.id ||
    available.find((runtime) => runtime.installed)?.id ||
    available[0]?.id ||
    "";
  const desktop = isMyGo();
  const change = (
    profile: Partial<Agent["profile"]>,
    mode: AutoSaveMode = "immediate",
  ) =>
    updateDraft((d) => ({ ...d, profile: { ...d.profile, ...profile } }), mode);
  const setDirectory = (id: string, path: string) =>
    change(
      {
        roots: p.roots.map((root) =>
          root.id === id ? { ...root, path } : root,
        ),
      },
      "debounced",
    );
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
    change(
      { roots, primaryRootId: p.primaryRootId || roots[0].id },
      "immediate",
    );
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
      change(
        {
          roots: p.roots.map((root) =>
            root.id === rootId ? { ...root, path } : root,
          ),
        },
        "immediate",
      );
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

  function applySavedAgent(saved: Agent) {
    queryClient.setQueryData<Overview>(
      ["overview"],
      (data) =>
        data && {
          ...data,
          agents: data.agents.map((current) =>
            current.id === saved.id ? saved : current,
          ),
        },
    );
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
    void queryClient.invalidateQueries({ queryKey: copyKey(saved.id) });
    void queryClient.invalidateQueries({
      queryKey: worktreeOptionsKey(saved.id),
    });
  }

  // Creation mode uses an explicit submit mutation.
  const createSave = useMutation({
    mutationFn: (value: Agent) => {
      const providerAvailable = available.some(
        (runtime) => runtime.id === value.profile.provider,
      );
      const payload =
        value.profile.provider && !providerAvailable
          ? {
              ...value,
              profile: {
                ...value.profile,
                provider: "",
                model: "",
                effort: "",
                fast: false,
              },
            }
          : value;
      return api<Agent>("/agents", payload, "POST");
    },
    onSuccess: (saved) => {
      applySavedAgent(saved);
      creation?.onSave(saved);
      toast.success(t("profile.saved"));
    },
  });

  const latestDraftSigRef = useRef(profileContentSignature(draft, homeDir));
  useLayoutEffect(() => {
    latestDraftSigRef.current = profileContentSignature(draft, homeDir);
  });

  const autoSave = useAutoSave<Agent, Agent>({
    initialSignature: existingAgent
      ? profileContentSignature(existingAgent, homeDir)
      : undefined,
    save: (value) => api<Agent>(`/agents/${value.id}`, value, "PUT"),
    rebase: (latest, saved) => ({
      ...latest,
      updatedAt: saved.updatedAt,
    }),
    onSaved: (saved, _sent, sentSig) => {
      archiveSave.reset();
      prevSavedRef.current = saved;
      seenUpdatedAts.current.add(saved.updatedAt);
      setSavedProfile(saved);
      const savedSig = profileContentSignature(saved, homeDir);
      autoSave.syncSaved(savedSig);
      if (latestDraftSigRef.current === sentSig) {
        dirtyByUserRef.current = false;
        setBaseDraft(saved);
      } else {
        setBaseDraft((current) => ({ ...current, updatedAt: saved.updatedAt }));
      }
      applySavedAgent(saved);
    },
  });

  // Archive / Restore keeps an explicit action so a 409 conflict (active runs)
  // never leaves the local toggle out of sync with server state.
  const archiveSave = useMutation({
    mutationFn: (value: Agent) =>
      api<Agent>(`/agents/${existingAgent!.id}`, value, "PUT"),
    onSuccess: (saved) => {
      prevSavedRef.current = saved;
      seenUpdatedAts.current.add(saved.updatedAt);
      dirtyByUserRef.current = false;
      setSavedProfile(saved);
      setBaseDraft(saved);
      autoSave.syncSaved(profileContentSignature(saved, homeDir));
      applySavedAgent(saved);
    },
  });

  // Reconcile external updates (e.g. Skills page toggles or sidebar archive).
  useEffect(() => {
    if (!existingAgent) return;
    if (
      savedProfile.updatedAt === existingAgent.updatedAt ||
      seenUpdatedAts.current.has(existingAgent.updatedAt)
    )
      return;
    seenUpdatedAts.current.add(existingAgent.updatedAt);
    const previous = savedProfile;
    setSavedProfile(existingAgent);
    prevSavedRef.current = existingAgent;
    const externalSig = profileContentSignature(existingAgent, homeDir);
    autoSave.syncSaved(externalSig);
    setBaseDraft((current) => {
      const rebased = rebaseProfileDraft(current, previous, existingAgent);
      if (profileContentSignature(rebased, homeDir) === externalSig) {
        dirtyByUserRef.current = false;
      }
      return rebased;
    });
  }, [existingAgent, savedProfile, homeDir, autoSave.syncSaved]);

  const installed = providers.data?.find(
    (provider) => provider.id === previewProviderId,
  );
  const supportsSkills = installed?.capabilities.skills === true;
  const skillSources = useSkillSources(
    previewProviderId,
    { roots: p.roots, primaryRootId: p.primaryRootId },
    hasDraft && supportsSkills && showOptions,
  );
  const collaborators = showOptions
    ? agents.filter(
        (target) =>
          target.id !== agent.id &&
          (!target.archived ||
            delegations.some(
              ({ deviceId, agentId }) => !deviceId && agentId === target.id,
            )),
      )
    : [];
  const delegationSettingsQuery = useDelegationSettings(showOptions);
  const delegationDefaults =
    delegationSettingsQuery.data ?? defaultDelegationSettings;
  const effectivePolicy = effectiveDelegationPolicy(p, delegationDefaults);
  const remoteTargetsQuery = useRemoteDelegationTargets({
    enabled: showOptions,
  });
  const remoteTargets = remoteTargetsQuery.data ?? [];
  const remoteBindingsQuery = useQuery({
    queryKey: ["remote", "bindings", "probe"],
    queryFn: () => api<{ hubId: string }[]>("/remote", { action: "status" }),
    enabled: showOptions,
    staleTime: 30_000,
    retry: false,
  });
  const hasRemoteSpaces =
    (remoteBindingsQuery.data?.length ?? 0) > 0 ||
    remoteTargets.length > 0 ||
    p.allowRemoteDelegation === false ||
    delegations.some((rule) => !!rule.deviceId);
  const eligibleLocalAll = collaborators.filter(
    (target) => !target.archived && canAcceptDelegations(target.profile),
  );
  const onlineRemoteTargets = remoteTargets.filter(
    (target) => target.online && !target.draining,
  );
  const remoteSelectionTargets = useMemo(() => {
    const map = new Map<
      string,
      {
        deviceId: string;
        deviceName: string;
        agentId: string;
        name: string;
        description?: string;
        online: boolean;
      }
    >();
    for (const target of remoteTargets) {
      map.set(`${target.deviceId}:${target.agentId}`, {
        deviceId: target.deviceId,
        deviceName: target.deviceName,
        agentId: target.agentId,
        name: target.name,
        description: target.description,
        online: target.online && !target.draining,
      });
    }
    for (const rule of delegations) {
      if (!rule.deviceId) continue;
      const key = `${rule.deviceId}:${rule.agentId}`;
      if (!map.has(key)) {
        map.set(key, {
          deviceId: rule.deviceId,
          deviceName: rule.deviceId.slice(0, 8),
          agentId: rule.agentId,
          name: rule.agentId.slice(0, 8),
          online: false,
        });
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.deviceName !== b.deviceName)
        return a.deviceName.localeCompare(b.deviceName);
      return a.name.localeCompare(b.name);
    });
  }, [remoteTargets, delegations]);
  const savedScope = JSON.stringify([
    savedProfile.profile.primaryRootId,
    savedProfile.profile.roots.map((r) => ({
      id: r.id,
      path: displayPath(r.path, homeDir),
    })),
  ]);
  const currentScope = JSON.stringify([
    p.primaryRootId,
    p.roots.map((r) => ({
      id: r.id,
      path: displayPath(r.path, homeDir),
    })),
  ]);
  const directoriesChanged = savedScope !== currentScope;
  const emptyScope = p.roots.length === 0;
  const choosePrimary = !creating || p.roots.length > 1;

  const nameInvalid = !creating && !draft.name.trim();
  const hasEmptyRoot = p.roots.some((root) => !root.path.trim());

  const canAutoSave =
    !creating &&
    !archiveSave.isPending &&
    !emptyScope &&
    !nameInvalid &&
    !hasEmptyRoot;

  useEffect(() => {
    if (creating) return;
    if (!dirtyByUserRef.current) return;
    if (!canAutoSave) {
      autoSave.cancelPending();
      return;
    }
    const sig = profileContentSignature(draft, homeDir);
    autoSave.schedule(draft, sig, pendingModeRef.current);
  }, [
    creating,
    canAutoSave,
    draft,
    homeDir,
    autoSave.schedule,
    autoSave.cancelPending,
  ]);

  const busy = creating
    ? pickDirectory.isPending || createSave.isPending
    : pickDirectory.isPending || archiveSave.isPending;
  const noAvailableRuntime = !!providers.data && available.length === 0;
  const canCreate =
    !busy &&
    hasDraft &&
    !emptyScope &&
    !!draft.name.trim() &&
    !noAvailableRuntime &&
    !hasEmptyRoot;

  function flushOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (!creating && event.key === "Enter") {
      event.preventDefault();
      autoSave.flush();
    }
  }

  const openDirectoryLabel = t(
    desktop && runtime().platform === "darwin"
      ? "profile.openInFinder"
      : "profile.openDirectory",
  );
  const scopeLocked = !!linkedProject;
  const pathRows = p.roots.map((root) => {
    const rootInvalid = !creating && !root.path.trim();
    const actions = !scopeLocked ? (
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
              change(
                {
                  roots,
                  primaryRootId:
                    p.primaryRootId === root.id
                      ? (roots[0]?.id ?? "")
                      : p.primaryRootId,
                },
                "immediate",
              );
            }}
          >
            <Trash2 />
            {t("profile.removeDirectory")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : desktop && root.path.trim() ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={openDirectoryLabel}
        title={openDirectoryLabel}
        disabled={openDirectory.isPending}
        onClick={() => openDirectory.mutate(root.path)}
      >
        <ExternalLink />
      </Button>
    ) : null;
    return (
      <div key={root.id} className="grid gap-1">
        <Field
          orientation="horizontal"
          className="profile-path-row"
          data-disabled={busy || scopeLocked}
        >
          {choosePrimary && (
            <RadioGroupItem
              aria-label={t("profile.defaultDirectory", {
                path: displayPath(root.path, homeDir),
              })}
              value={root.id}
              disabled={busy || scopeLocked}
            />
          )}
          <InputGroup>
            <InputGroupAddon>
              <Folder />
            </InputGroupAddon>
            <InputGroupInput
              id={`${scopeId}-root-${root.id}`}
              form={creating ? formId : undefined}
              onInvalid={() => {
                // Reveal the field in time for the browser to focus it.
                if (scopeTab !== "directories")
                  flushSync(() => setScopeTab("directories"));
              }}
              aria-label={t("profile.scopeDirectory")}
              aria-invalid={rootInvalid || undefined}
              aria-describedby={
                rootInvalid ? `${scopeId}-root-${root.id}-error` : undefined
              }
              placeholder="~/path/to/workspace"
              title={root.path}
              value={creating ? root.path : displayPath(root.path, homeDir)}
              disabled={busy || scopeLocked}
              onFocus={creating ? () => setEditingRoot(root.id) : undefined}
              onBlur={() => {
                if (creating) setEditingRoot(undefined);
                else autoSave.flush();
              }}
              onKeyDown={flushOnEnter}
              onChange={(event) => setDirectory(root.id, event.target.value)}
              required
              pattern=".*\S.*"
            />
            {creating && !scopeLocked && (
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
        {rootInvalid && (
          <FieldError
            id={`${scopeId}-root-${root.id}-error`}
            className="text-xs"
          >
            {t("profile.directoryRequired")}
          </FieldError>
        )}
      </div>
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
  const projectSelector = (
    projects.length > 0 ||
    !!linkedProject ||
    (!creating && !emptyScope && !hasEmptyRoot)
  ) && (
    <div className="flex flex-wrap items-center gap-2">
      {(projects.length > 0 || !!linkedProject) && (
        <Select
          value={linkedProject?.id ?? "__independent__"}
          disabled={busy}
          onValueChange={(value) => {
            if (value === "__independent__") {
              change({ projectId: "" }, "immediate");
              return;
            }
            const target = projects.find((item) => item.id === value);
            if (!target) return;
            change(
              {
                projectId: target.id,
                roots: target.roots.map((root) => ({ ...root })),
                primaryRootId: target.primaryRootId,
                worktreeSetup: target.worktreeSetup
                  ? { ...target.worktreeSetup }
                  : undefined,
              },
              "immediate",
            );
          }}
        >
          <SelectTrigger
            id={`${scopeId}-project`}
            aria-label={t("profile.project")}
            className="min-w-0 flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__independent__">
                {t("profile.projectIndependent")}
              </SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <Folder />
                  {project.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
      {linkedProject ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setProjectDialog("edit")}
        >
          {t("projects.editAction")}
        </Button>
      ) : (
        !creating &&
        !emptyScope &&
        !hasEmptyRoot && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setProjectDialog("create")}
          >
            <FolderPlus data-icon="inline-start" />
            {t("projects.saveAsShared")}
          </Button>
        )
      )}
    </div>
  );
  const directories = (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      {projectSelector}
      {!creating && (
        <div
          className={
            emptyScope
              ? "grid justify-items-start gap-2"
              : "flex flex-wrap items-center justify-between gap-2"
          }
        >
          <p id={`${scopeId}-scope-hint`} className="profile-note">
            {linkedProject
              ? t("profile.projectManagedHint", { name: linkedProject.name })
              : t(emptyScope ? "profile.emptyScopeHint" : "profile.scopeHint")}
          </p>
          {!scopeLocked && directoryActions}
        </div>
      )}
      {creating && p.roots.length > 1 && !scopeLocked && (
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
          disabled={busy || scopeLocked}
          onValueChange={(primaryRootId) =>
            change({ primaryRootId }, "immediate")
          }
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
              key={`${worktreeOwner}:${worktreeOwnerId}:${savedScope}`}
              agentId={worktreeOwnerId}
              owner={worktreeOwner}
              agents={agents}
              tab={scopeTab}
              canCreate={!agent.archived}
              setup={setup}
              setupFields={
                !draft.archived &&
                (linkedProject ? (
                  <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                    <span>
                      {t("profile.projectManagedHint", {
                        name: linkedProject.name,
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setProjectDialog("edit")}
                    >
                      {t("projects.editAction")}
                    </Button>
                  </div>
                ) : (
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
                        ownerId={agent.id}
                        formId={formId}
                        commands={p.worktreeSetup ?? {}}
                        onChange={(worktreeSetup) =>
                          change({ worktreeSetup }, "debounced")
                        }
                        onFlush={creating ? undefined : autoSave.flush}
                      />
                    </CollapsibleContent>
                  </Collapsible>
                ))
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
        onFocusOutside={(event) => {
          if (event.target === document.body) event.preventDefault();
        }}
      >
        <Suspense fallback={<Loading />}>
          <AvatarPicker
            agent={draft}
            onChange={(avatar) =>
              updateDraft((current) => ({ ...current, avatar }), "immediate")
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
      form={creating ? formId : undefined}
      autoFocus={creating && !focusNameAfterSourceChange.current}
      onFocus={(event) => {
        if (selectCopyName.current) {
          selectCopyName.current = false;
          event.currentTarget.select();
        }
      }}
      placeholder={t("profile.namePlaceholder")}
      value={draft.name}
      aria-invalid={nameInvalid || undefined}
      aria-describedby={nameInvalid ? `${scopeId}-name-error` : undefined}
      onChange={(e) => {
        const name = e.target.value;
        updateDraft((current) => ({ ...current, name }), "debounced");
      }}
      onBlur={creating ? undefined : () => autoSave.flush()}
      onKeyDown={flushOnEnter}
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
        <>
          {nameControl}
          {nameInvalid && (
            <FieldError id={`${scopeId}-name-error`} className="text-xs">
              {t("profile.nameRequired")}
            </FieldError>
          )}
        </>
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
          createSave.reset();
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
  const instructionsId = `${scopeId}-instructions`;
  const instructionsInput = (
    <Textarea
      id={instructionsId}
      form={creating ? formId : undefined}
      rows={creating ? 3 : 9}
      placeholder={t("profile.instructionsPlaceholder")}
      value={p.instructions}
      onChange={(e) => change({ instructions: e.target.value }, "debounced")}
      onBlur={creating ? undefined : () => autoSave.flush()}
    />
  );
  const normalizedPermissionPolicy = normalizeAgentPermissionPolicy(
    p.permission,
  );
  const permissionToggleValue = normalizedPermissionPolicy || "inherit";
  const currentRuntimeLabel = installed
    ? connectionName(installed, providers.data ?? [], t)
    : p.provider;
  const currentSelectionSummary = [
    currentRuntimeLabel,
    p.model || (p.provider ? t("profile.defaultModel") : ""),
    p.effort
      ? t(`models.effort.${p.effort}`, { defaultValue: p.effort })
      : "",
    p.fast ? "Fast" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const permissionCard = !creating && (
    <Card className="profile-card profile-runtime">
      <CardHeader>
        <CardTitle>{t("profile.permission")}</CardTitle>
        <CardDescription>{t("profile.permissionPolicyHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            className="flex-wrap"
            value={permissionToggleValue}
            aria-label={t("profile.permission")}
            disabled={busy}
            onValueChange={(value) => {
              if (!value) return;
              const nextPolicy: AgentPermissionPolicy =
                value === "inherit"
                  ? ""
                  : (value as Exclude<AgentPermissionPolicy, "">);
              if (!AGENT_PERMISSION_POLICIES.includes(nextPolicy)) return;
              change({ permission: nextPolicy }, "immediate");
            }}
          >
            {AGENT_PERMISSION_POLICIES.map((policy) => {
              const value = policy || "inherit";
              return (
                <ToggleGroupItem key={value} value={value}>
                  {t(`profile.permissionPolicy.${value}`)}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {permissionToggleValue === "inherit"
              ? t("profile.permissionPolicy.inheritHint", {
                  mode: t(
                    globalPermissionMode === "yolo"
                      ? "profile.permissionPolicy.full_access"
                      : "profile.permissionPolicy.auto",
                  ),
                })
              : t(`profile.permissionPolicy.${permissionToggleValue}Hint`)}
          </p>
        </div>
        {currentSelectionSummary && (
          <p className="profile-runtime-status profile-note">
            {installed && <RuntimeIcon provider={installed} />}
            <span className="truncate">{currentSelectionSummary}</span>
            <span className="text-muted-foreground/75">
              · {t("profile.modelSwitchInComposer")}
            </span>
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
      skillContext={installed?.capabilities.skillContext}
      onChange={(disabledSkills) => change({ disabledSkills }, "immediate")}
    />
  );
  const additionalSkills = (
    <ProfileSkills
      paths={p.skills ?? []}
      homeDir={homeDir}
      onChange={(skills) => change({ skills }, "immediate")}
    />
  );
  const delegationFields = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={effectivePolicy}
          aria-label={t("profile.delegationPolicy")}
          disabled={busy}
          onValueChange={(value) => {
            if (value !== "none" && value !== "all" && value !== "selected")
              return;
            change(
              { delegationPolicy: value as DelegationPolicy },
              "immediate",
            );
          }}
        >
          <ToggleGroupItem value="none">
            {t("profile.delegationPolicy.none")}
          </ToggleGroupItem>
          <ToggleGroupItem value="all">
            {t("profile.delegationPolicy.all")}
          </ToggleGroupItem>
          <ToggleGroupItem value="selected">
            {t("profile.delegationPolicy.selected")}
          </ToggleGroupItem>
        </ToggleGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`profile.delegationPolicy.${effectivePolicy}Hint`)}
          {effectivePolicy === "all" &&
            !p.delegationPolicy &&
            delegationDefaults.defaultPolicy === "all" && (
              <> {t("profile.delegationPolicy.allGlobalNote")}</>
            )}
        </p>
      </div>

      {effectivePolicy === "all" && (
        <div className="flex flex-col gap-3">
          {eligibleLocalAll.length === 0 &&
          (!allowsRemoteDelegation(p) || onlineRemoteTargets.length === 0) ? (
            <Empty className="profile-empty">
              <EmptyDescription>
                {t("profile.delegationAllEmpty")}
              </EmptyDescription>
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {eligibleLocalAll.map((target) => (
                  <span
                    key={target.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs"
                    title={target.profile.description || target.name}
                  >
                    <AgentAvatar agent={target} size="xs" />
                    <span className="max-w-36 truncate">{target.name}</span>
                  </span>
                ))}
                {allowsRemoteDelegation(p) &&
                  onlineRemoteTargets.map((target) => (
                    <span
                      key={`${target.deviceId}:${target.agentId}`}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      title={
                        [target.deviceName, target.description]
                          .filter(Boolean)
                          .join(" · ") || target.name
                      }
                    >
                      <Monitor
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="max-w-24 truncate text-muted-foreground">
                        {target.deviceName}
                      </span>
                      <span aria-hidden className="text-muted-foreground">
                        ·
                      </span>
                      <span className="max-w-36 truncate">{target.name}</span>
                    </span>
                  ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("profile.delegationAllCount", {
                  local: eligibleLocalAll.length,
                  remotePart:
                    allowsRemoteDelegation(p) && onlineRemoteTargets.length > 0
                      ? t("profile.delegationAllRemotePart", {
                          remote: onlineRemoteTargets.length,
                        })
                      : "",
                })}
              </p>
            </div>
          )}
          {hasRemoteSpaces && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border/70 px-3 py-2.5">
              <div className="min-w-0">
                <label
                  htmlFor={`${scopeId}-allow-remote-delegation`}
                  className="text-xs font-medium"
                >
                  {t("profile.delegationAllowRemote")}
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("profile.delegationAllowRemoteHint")}
                </p>
              </div>
              <Switch
                id={`${scopeId}-allow-remote-delegation`}
                size="sm"
                disabled={busy}
                checked={allowsRemoteDelegation(p)}
                onCheckedChange={(allowRemoteDelegation) =>
                  change({ allowRemoteDelegation }, "immediate")
                }
              />
            </div>
          )}
        </div>
      )}

      {effectivePolicy === "selected" &&
        (collaborators.length === 0 && remoteSelectionTargets.length === 0 ? (
          <Empty className="profile-empty">
            <EmptyDescription>{t("profile.delegationsHint")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {collaborators.length > 0 && (
              <FieldGroup className="profile-delegations">
                {collaborators.map((target) => {
                  const rule = delegations.find(
                    (d) => !d.deviceId && d.agentId === target.id,
                  );
                  const accepting = canAcceptDelegations(target.profile);
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
                          change(
                            {
                              delegationPolicy: "selected",
                              delegations: checked
                                ? [
                                    ...delegations,
                                    { agentId: target.id, confirm: false },
                                  ]
                                : delegations.filter(
                                    (d) =>
                                      !!d.deviceId || d.agentId !== target.id,
                                  ),
                            },
                            "immediate",
                          )
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
                        {!accepting && (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px]"
                          >
                            {t("profile.delegationNotAccepting")}
                          </Badge>
                        )}
                      </FieldLabel>
                      {target.profile.description && (
                        <span
                          className="max-w-64 truncate text-xs text-muted-foreground"
                          title={target.profile.description}
                        >
                          {target.profile.description}
                        </span>
                      )}
                      {rule && (
                        <label className="profile-confirm">
                          <Switch
                            size="sm"
                            disabled={target.archived}
                            checked={rule.confirm}
                            onCheckedChange={(confirm) =>
                              change(
                                {
                                  delegationPolicy: "selected",
                                  delegations: delegations.map((d) =>
                                    !d.deviceId && d.agentId === target.id
                                      ? { ...d, confirm }
                                      : d,
                                  ),
                                },
                                "immediate",
                              )
                            }
                          />
                          {t("profile.confirm")}
                        </label>
                      )}
                    </Field>
                  );
                })}
              </FieldGroup>
            )}
            {remoteSelectionTargets.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("profile.delegationRemoteGroup")}
                </span>
                <FieldGroup className="profile-delegations">
                  {remoteSelectionTargets.map((target) => {
                    const rule = delegations.find(
                      (d) =>
                        d.deviceId === target.deviceId &&
                        d.agentId === target.agentId,
                    );
                    const key = `${target.deviceId}:${target.agentId}`;
                    return (
                      <Field
                        key={key}
                        orientation="horizontal"
                        className="profile-delegation"
                      >
                        <Checkbox
                          id={`${scopeId}-delegate-remote-${key}`}
                          checked={!!rule}
                          onCheckedChange={(checked) =>
                            change(
                              {
                                delegationPolicy: "selected",
                                delegations: checked
                                  ? [
                                      ...delegations,
                                      {
                                        deviceId: target.deviceId,
                                        agentId: target.agentId,
                                        confirm: false,
                                      },
                                    ]
                                  : delegations.filter(
                                      (d) =>
                                        d.deviceId !== target.deviceId ||
                                        d.agentId !== target.agentId,
                                    ),
                              },
                              "immediate",
                            )
                          }
                        />
                        <FieldLabel
                          htmlFor={`${scopeId}-delegate-remote-${key}`}
                          className="profile-collaborator"
                        >
                          <Monitor
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate" title={target.name}>
                            {target.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px]"
                          >
                            {target.deviceName}
                          </Badge>
                          {!target.online && (
                            <span className="text-[11px] text-muted-foreground">
                              {t("profile.delegationRemoteOffline")}
                            </span>
                          )}
                        </FieldLabel>
                        {target.description && (
                          <span
                            className="max-w-64 truncate text-xs text-muted-foreground"
                            title={target.description}
                          >
                            {target.description}
                          </span>
                        )}
                        {rule && (
                          <label className="profile-confirm">
                            <Switch
                              size="sm"
                              checked={rule.confirm}
                              onCheckedChange={(confirm) =>
                                change(
                                  {
                                    delegationPolicy: "selected",
                                    delegations: delegations.map((d) =>
                                      d.deviceId === target.deviceId &&
                                      d.agentId === target.agentId
                                        ? { ...d, confirm }
                                        : d,
                                    ),
                                  },
                                  "immediate",
                                )
                              }
                            />
                            {t("profile.confirm")}
                          </label>
                        )}
                      </Field>
                    );
                  })}
                </FieldGroup>
              </div>
            )}
          </div>
        ))}

      <div className="flex items-start justify-between gap-3 border-t border-border/70 pt-3">
        <div className="min-w-0">
          <label
            htmlFor={`${scopeId}-accept-delegations`}
            className="text-xs font-medium"
          >
            {t("profile.delegationAccept")}
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("profile.delegationAcceptHint")}
          </p>
        </div>
        <Switch
          id={`${scopeId}-accept-delegations`}
          size="sm"
          disabled={busy}
          checked={canAcceptDelegations(p)}
          onCheckedChange={(acceptDelegations) =>
            change({ acceptDelegations }, "immediate")
          }
        />
      </div>
    </div>
  );

  const editError = archiveSave.error ?? autoSave.error;

  return (
    <div className={creating ? "agent-create-form" : "profile-form"}>
      {creating && (
        /* Inline Scope editors own their own form submissions. */
        <form
          id={formId}
          hidden
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) createSave.mutate(draft);
          }}
        />
      )}
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
                createSave.reset();
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
                        {!scopeLocked && directoryActions}
                      </div>
                      {directories}
                    </Field>
                    <Field className="agent-create-role">
                      <FieldLabel htmlFor={instructionsId}>
                        {t("profile.roleOptional")}
                      </FieldLabel>
                      {instructionsInput}
                    </Field>
                    {providers.error && (
                      <ErrorNotice
                        error={providers.error}
                        retry={() => void providers.refetch()}
                      />
                    )}
                    {noAvailableRuntime && (
                      <p className="profile-note">
                        {t("channels.enableRuntime")}
                      </p>
                    )}
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
              <div className="grid min-w-0 flex-1 max-w-md gap-2">
                {nameField}
                <Field>
                  <FieldLabel
                    htmlFor={`${scopeId}-description`}
                    className="sr-only"
                  >
                    {t("profile.description")}
                  </FieldLabel>
                  <Input
                    id={`${scopeId}-description`}
                    placeholder={t("profile.descriptionPlaceholder")}
                    maxLength={240}
                    value={p.description ?? ""}
                    onChange={(e) =>
                      change({ description: e.target.value }, "debounced")
                    }
                    onBlur={() => autoSave.flush()}
                    onKeyDown={flushOnEnter}
                  />
                </Field>
              </div>
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
            {permissionCard}
            {scopeCard}
            {disabledSkills}
            {additionalSkills}
            <Card className="profile-card profile-wide">
              <CardHeader>
                <CardTitle>{t("profile.delegations")}</CardTitle>
              </CardHeader>
              <CardContent>{delegationFields}</CardContent>
            </Card>
          </div>
        </>
      )}
      <footer className="profile-actions">
        {creating && createSave.error && (
          <ErrorNotice error={createSave.error} />
        )}
        {!creating && !!editError && (
          <ErrorNotice
            error={editError}
            retry={archiveSave.error ? undefined : autoSave.retry}
          />
        )}
        {creating ? (
          <>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" form={formId} disabled={!canCreate}>
              {t(
                createSave.isPending
                  ? "profile.saving"
                  : copyMode
                    ? "agents.createCopy"
                    : "agents.create",
              )}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-muted-foreground"
              title={t("profile.archiveHint")}
              onClick={() => {
                autoSave.cancelPending();
                archiveSave.mutate({
                  ...draft,
                  archived: !savedProfile.archived,
                });
              }}
              disabled={
                !canAutoSave || busy || autoSave.saving || archiveSave.isPending
              }
            >
              <Archive data-icon="inline-start" />
              {savedProfile.archived
                ? t("profile.restore")
                : t("profile.archive")}
            </Button>
            {(autoSave.saving || archiveSave.isPending) && (
              <span role="status" className="text-xs text-muted-foreground">
                {t("common.saving")}
              </span>
            )}
          </>
        )}
      </footer>
      <ProjectDialog
        open={projectDialog !== null}
        onOpenChange={(open) => {
          if (!open) setProjectDialog(null);
        }}
        project={projectDialog === "edit" ? linkedProject : undefined}
        initialScope={
          projectDialog === "create"
            ? { roots: p.roots, primaryRootId: p.primaryRootId }
            : undefined
        }
        initialWorktreeSetup={
          projectDialog === "create" ? p.worktreeSetup : undefined
        }
        agents={agents}
        homeDir={homeDir}
        onSaved={(saved) => {
          if (projectDialog === "create") {
            change(
              {
                projectId: saved.id,
                roots: saved.roots.map((root) => ({ ...root })),
                primaryRootId: saved.primaryRootId,
                worktreeSetup: saved.worktreeSetup
                  ? { ...saved.worktreeSetup }
                  : undefined,
              },
              "immediate",
            );
          }
        }}
      />
    </div>
  );
}
