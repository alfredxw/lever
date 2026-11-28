import {
  type ReactElement,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useIsMutating,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import {
  ArrowUp,
  Clock,
  Columns2,
  CornerUpRight,
  Folder,
  Folders,
  ListPlus,
  Check,
  X,
  LoaderCircle,
  MessageCircle,
  MessagesCircle,
  Pause,
  Play,
  Plus,
  Square,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import { MaxComparisonAgents } from "@/api/types.gen";
import type {
  Agent,
  Attachment,
  Comparison,
  ComparisonInput,
  Overview,
  Profile,
  Run,
  RunDependency,
  Selection,
  SendInput,
  Session,
} from "@/api/types.gen";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Toggle } from "@/components/ui/toggle";
import { ErrorNotice } from "@/components/common";
import { cn } from "@/lib/utils";
import { Attachments } from "./Attachments";
import { useImagePreview } from "./ImagePreview";
import { ModelPicker } from "./ModelPicker";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput";
import type { ComposerBrowser, ComposerCommand } from "./composerActions";
import { extractDroppedFiles, hasDraggedFiles } from "./composerFiles";
import {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  nextPastedTextFileName,
} from "./composerTextPaste";
import { ComposerContext, KeepConversationOpen } from "./ComposerContext";
import {
  clearSubmission,
  recoverTopicLauncherDraft,
  readSubmission,
  saveComposerDraft,
  saveSubmission,
  useComposerDraft,
  type DraftSelection,
} from "./composerDraft";
import { useComposerModel } from "./useComposerModel";
import { useComparisonModels } from "./useComparisonModels";
import {
  allowsRemoteDelegation,
  canAcceptDelegations,
  effectiveDelegationPolicy,
  useRemoteDelegationTargets,
} from "@/features/agents/delegationPolicy";
import {
  isLeverReference,
  messagePrompt,
  serializePrompt,
  textPrompt,
} from "./prompt";
import { QuotedMessage } from "./QuotedMessage";
import { QueuedMessages } from "./QueuedMessages";
import { hasDifferentModelSettings, steerModelHint } from "./steer";
import { ComparisonPicker } from "./ComparisonPicker";
import { WaitRunPicker } from "./WaitRunPicker";
import {
  defaultWaitRunIds,
  isDependencyBlocked,
  isRunWaitingBlocked,
  listWaitableRuns,
  runDisplayTitle,
} from "./waitRuns";
import {
  useComposerShortcuts,
  usePreferences,
} from "@/features/settings/Preferences";
import {
  formatShortcut,
  pasteAsTextShortcut,
} from "@/features/settings/shortcuts";
import { ContextMeter } from "./ContextMeter";
import { PermissionMenu } from "@/features/runtime/Permissions";
import {
  resolveAgentPermissionForCatalog,
  usePermissionMapping,
  type PermissionSource,
} from "@/features/runtime/permissionMapping";
import type { EffortSource } from "@/features/runtime/effortMapping";
import { persistAgentSelection } from "@/features/runtime/queries";
import {
  agentProfileSelection,
  rememberModel,
  useRuntimePreferences,
} from "@/features/runtime/runtimePreferences";
import { WorkingDirectoryPicker } from "@/features/worktrees/WorkingDirectoryPicker";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import { canPauseReply, interruptReply, recoverRun } from "./runControls";

const MotionInputGroupButton = motion.create(InputGroupButton);

const followUpActions = {
  queue: { label: "queue.add", shortLabel: "queue.queueLabel", Icon: ListPlus },
  steer: {
    label: "queue.steer",
    shortLabel: "queue.steerLabel",
    Icon: CornerUpRight,
  },
} as const;

type RunPermissionChange = { run: Run } & (
  | { permission: string }
  | { allow: boolean }
);

export function Composer({
  agentId,
  agents = [],
  chatId,
  draftAgentId,
  sharedScope,
  session,
  profile,
  reply,
  fixedSession,
  topicLauncher,
  compact,
  activeRun,
  resumableRun,
  queuedRuns = [],
  hasActiveDelegations,
  archived,
  autoFocus,
  visible,
  onSent,
  onOpenHandoffTopic,
}: {
  agentId: string;
  agents?: Agent[];
  chatId: string;
  draftAgentId?: string;
  sharedScope?: SendInput["sharedScope"];
  session?: Session;
  profile: Profile;
  reply?: boolean;
  fixedSession?: boolean;
  topicLauncher?: { topicId: string; backButton: ReactElement };
  compact?: boolean;
  activeRun?: Run;
  resumableRun?: Run;
  queuedRuns?: Run[];
  hasActiveDelegations?: boolean;
  archived?: boolean;
  autoFocus?: boolean;
  visible?: boolean;
  onSent: (result: Run | Comparison, launchedFromTopicId?: string) => void;
  onOpenHandoffTopic?: (run: Run) => void;
}) {
  const { t } = useTranslation();
  const composer = useContext(ComposerContext);
  const keepOpen = useContext(KeepConversationOpen);
  const preview = useImagePreview();
  const { preferences: appPreferences } = usePreferences();
  const shortcuts = useComposerShortcuts();
  const reduceMotion = useReducedMotion();
  const key = reply ? session!.id : chatId;
  useEffect(() => {
    if (!reply && !fixedSession && !draftAgentId)
      recoverTopicLauncherDraft(chatId);
  }, [chatId, draftAgentId, fixedSession, reply]);
  const sending = useIsMutating({ mutationKey: ["message", key] }) > 0;
  const [draft, setDraft] = useComposerDraft(key);
  const preferences = useRuntimePreferences(agentId);
  const pending = readSubmission(key);
  const backToMessagesButton = topicLauncher?.backButton;
  const launchTopic = !!topicLauncher && !draft.editing && !pending;
  const topicMode = !reply && !fixedSession && (launchTopic || draft.topic);
  const operation = reply ? "reply" : topicMode ? "topic" : "main";
  const selectionField =
    topicMode && !draft.editing ? "topicSelection" : "sessionSelection";
  const comparisonAgents =
    topicMode && !draft.editing ? draft.comparisonAgents : undefined;
  const shareScope = Boolean(comparisonAgents && draft.comparisonSharedScope);
  const replaceRunId = draft.editing?.sent ? draft.editing.runId : undefined;
  const editingSent = !!replaceRunId;
  const [modelOpen, setModelOpen] = useState(false);
  const [actionMenu, setActionMenu] = useState<ComposerBrowser | null>(null);
  const actionsId = useId();
  const [uploading, setUploading] = useState(false);
  const actionsDisabled = Boolean(
    uploading || sending || archived || compact || visible === false,
  );
  useEffect(() => setActionMenu(null), [key, actionsDisabled]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const intakeBusy = useRef(false);
  const canDropFiles = !archived && !sending && !uploading && visible !== false;
  useEffect(() => {
    if (!dragging) return;
    const clear = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [dragging]);
  useEffect(() => {
    if (!canDropFiles && dragging) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }, [canDropFiles, dragging]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textbox = useRef<ComposerInputHandle>(null);
  const composerRoot = useRef<HTMLDivElement>(null);
  const typingState = useRef<{ sessionId?: string; active: boolean; lastSent: number }>({
    active: false,
    lastSent: 0,
  });
  const notifyTyping = useEffectEvent((targetSessionId: string | undefined, active: boolean) => {
    const state = typingState.current;
    if (!active) {
      const clearId = targetSessionId ?? state.sessionId;
      if (state.active && clearId) {
        state.active = false;
        state.lastSent = 0;
        state.sessionId = undefined;
        void api(`/sessions/${clearId}/typing`, { active: false }).catch(() => {});
      }
      return;
    }
    if (!targetSessionId || !hasActiveDelegations || topicMode || archived || visible === false) {
      return;
    }
    const nowMs = Date.now();
    if (state.active && state.sessionId === targetSessionId && nowMs - state.lastSent < 3500) {
      return;
    }
    state.active = true;
    state.sessionId = targetSessionId;
    state.lastSent = nowMs;
    void api(`/sessions/${targetSessionId}/typing`, { active: true }).catch(() => {});
  });
  const choosingDirectory = topicMode && !draft.editing && !comparisonAgents;
  const copyId = choosingDirectory ? draft.workingCopyId : undefined;
  const copies = useWorkingCopies(
    profile.projectId || agentId,
    choosingDirectory && !archived && visible !== false,
    false,
    profile.projectId ? "project" : "agent",
  );
  const copy = copies.data?.find((item) => item.id === copyId);
  const copyAvailable = availableGroup(copy);
  const scopeSession = !topicMode || shareScope ? session : undefined;
  const currentScope = scopeSession ?? copy ?? profile;
  const cwd = primaryDirectory(currentScope);
  useEffect(() => {
    const currentId = scopeSession?.id;
    if (!hasActiveDelegations || topicMode || !currentId || visible === false) {
      notifyTyping(undefined, false);
    } else if (typingState.current.sessionId && typingState.current.sessionId !== currentId) {
      notifyTyping(typingState.current.sessionId, false);
    }
    return () => {
      notifyTyping(undefined, false);
    };
  }, [hasActiveDelegations, scopeSession?.id, topicMode, visible]);
  const profileSelection = agentProfileSelection(profile);
  const sessionSelection =
    !topicMode && session?.selection.provider ? session.selection : undefined;
  const currentSelection = sessionSelection ?? profileSelection;
  function selectionForProvider(
    provider: string,
    previous?: Selection,
  ): Selection {
    if (previous) return previous;
    if (provider === currentSelection.provider) return currentSelection;
    if (provider === profile.provider) return profileSelection;
    return {
      provider,
      model: "",
      effort: "",
      fast: false,
      ...preferences?.models[provider],
    };
  }
  const submitted =
    pending && "operation" in pending && pending.operation === operation
      ? pending.selection
      : undefined;
  const override = draft[selectionField];
  // Keep the original request selection for an idempotent retry after a lost response.
  const replaySelection =
    submitted &&
    (!override || JSON.stringify(override) === JSON.stringify(submitted))
      ? submitted
      : undefined;
  const ownSelection = override ?? submitted ?? sessionSelection;
  const candidateSelection = ownSelection ?? profileSelection;
  const candidateEffortSource =
    !replaySelection &&
    candidateSelection === override &&
    override?.effortSource
      ? override.effortSource
      : undefined;
  const providerDefaultFallback: Selection | undefined =
    !ownSelection && profileSelection.provider && profileSelection.model
      ? {
          provider: profileSelection.provider,
          model: "",
          effort: "",
          fast: false,
        }
      : undefined;
  const {
    providers,
    runtime,
    catalog,
    model,
    selection: resolvedSelection,
    runtimeUnavailable,
    modelUnavailable,
    checkingPreference,
  } = useComposerModel(
    candidateSelection,
    cwd,
    providerDefaultFallback,
    candidateEffortSource,
  );
  const {
    permissionSource,
    effortSource: _effortSource,
    ...selection
  }: DraftSelection = replaySelection ?? resolvedSelection;
  const pendingEffortSyncRef = useRef("");
  useEffect(() => {
    if (
      !candidateEffortSource ||
      draft.editing ||
      !catalog.isSuccess ||
      !model ||
      catalog.data?.provisional
    )
      return;
    const sig = JSON.stringify([
      agentId,
      selection.provider,
      selection.model,
      selection.effort,
      selection.fast,
    ]);
    if (pendingEffortSyncRef.current === sig) return;
    pendingEffortSyncRef.current = sig;
    rememberModel(agentId, selection, undefined, model.efforts);
    void persistAgentSelection(agentId, selection);
  }, [
    agentId,
    candidateEffortSource,
    catalog.data?.provisional,
    catalog.isSuccess,
    draft.editing,
    model,
    selection,
  ]);
  const preferFavorites =
    preferences?.favoriteSelections?.[selection.provider] === selection.model;
  const mapped = usePermissionMapping(
    permissionSource,
    selection.provider,
    cwd,
    catalog.data,
  );
  const configureRuntime = composer
    ? () => composer.openRuntimeSettings(selection.provider)
    : undefined;
  function setSelection(
    next: Selection,
    source?: PermissionSource,
    effortSource?: EffortSource,
  ) {
    setDraft((d) => ({
      ...d,
      [selectionField]: {
        ...next,
        permissionSource: source,
        effortSource,
      },
    }));
  }
  const prompt = serializePrompt(draft.content);
  const comparisonMessage = comparisonAgents && {
    chatId: draftAgentId ? "" : chatId,
    ...(draftAgentId ? { agentId: draftAgentId } : {}),
    agentIds: comparisonAgents,
    ...(shareScope ? { sharedScope: true } : {}),
    text: prompt.text,
    attachmentIds: draft.files.map((file) => file.id),
    ...(prompt.references.length ? { references: prompt.references } : {}),
    ...(draft.quote ? { quote: draft.quote } : {}),
  };
  // A retry reuses exactly what was sent, including pre-upgrade commands.
  const replayComparison =
    comparisonMessage &&
    pending &&
    "agentIds" in pending &&
    JSON.stringify({
      ...pending,
      commandId: undefined,
      selections: undefined,
    }) === JSON.stringify(comparisonMessage) &&
    Object.entries(draft.comparisonModels ?? {}).every(([id, choice]) => {
      const saved = pending.selections?.[id];
      return (
        saved &&
        saved.provider === choice.provider &&
        saved.permission === choice.permission &&
        !hasDifferentModelSettings(saved, choice)
      );
    })
      ? pending
      : undefined;
  const comparisonOwnerSelection = draft.comparisonSelection ?? selection;
  const inputProvider = (
    comparisonAgents ? comparisonOwnerSelection : selection
  ).provider;
  const participants = useComparisonModels(
    agents,
    comparisonAgents,
    agentId,
    comparisonOwnerSelection,
    providers,
    {
      overrides: draft.comparisonModels,
      submitted: replayComparison?.selections,
      sharedCwd: shareScope ? cwd : undefined,
    },
  );
  const comparisonSelections = Object.fromEntries(
    participants.flatMap(({ agent, available, selection }) =>
      available && selection && comparisonAgents?.includes(agent.id)
        ? [[agent.id, selection] as const]
        : [],
    ),
  );
  const canStartComparison =
    !reply &&
    !fixedSession &&
    !topicLauncher &&
    !draft.editing &&
    !mapped.pending &&
    !archived &&
    !comparisonAgents &&
    agents.filter((agent) => !agent.archived).length >= 2;
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview?scope=local"),
    enabled: visible !== false && !archived,
    subscribed: visible !== false && !archived,
  });
  const afterRunIds =
    !comparisonAgents && !editingSent ? draft.afterRunIds : undefined;
  const [afterPickerKey, setAfterPickerKey] = useState(0);
  const waitCandidates = useMemo(
    () =>
      listWaitableRuns(overview.data, currentScope, {
        excludeSessionId: reply ? session?.id : undefined,
        excludeRunId: draft.editing?.runId,
      }),
    [overview.data, currentScope, reply, session?.id, draft.editing?.runId],
  );
  const missingAfterIds = useMemo(() => {
    if (!afterRunIds?.length) return [];
    const live = new Set(overview.data?.runs.map((run) => run.id) ?? []);
    return afterRunIds.filter((id) => !live.has(id));
  }, [afterRunIds, overview.data?.runs]);
  const resolvedMissing = useQueries({
    queries: missingAfterIds.map((id) => ({
      queryKey: ["run", id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<Run>(`/runs/${id}`, undefined, "GET", signal),
      staleTime: 10_000,
      retry: false,
    })),
  });
  const resolvedAfterRuns = useMemo(() => {
    const map = new Map<
      string,
      Pick<RunDependency, "runId" | "title" | "status" | "blocked">
    >();
    for (const run of overview.data?.runs ?? []) {
      map.set(run.id, {
        runId: run.id,
        title: runDisplayTitle(run, overview.data),
        status: run.status,
        blocked: isDependencyBlocked(run.status) || isRunWaitingBlocked(run),
      });
    }
    for (const item of waitCandidates) {
      map.set(item.run.id, {
        runId: item.run.id,
        title: item.title,
        status: item.run.status,
        blocked: false,
      });
    }
    for (let i = 0; i < missingAfterIds.length; i++) {
      const run = resolvedMissing[i]?.data;
      if (run) {
        map.set(run.id, {
          runId: run.id,
          title: runDisplayTitle(run, overview.data),
          status: run.status,
          blocked: isDependencyBlocked(run.status) || isRunWaitingBlocked(run),
        });
      }
    }
    return map;
  }, [waitCandidates, missingAfterIds, resolvedMissing, overview.data]);
  const canStartAfter =
    !archived &&
    !editingSent &&
    !comparisonAgents &&
    afterRunIds === undefined &&
    waitCandidates.length > 0;
  const blockedAfterRun = Boolean(
    afterRunIds?.some((id) => {
      const info = resolvedAfterRuns.get(id);
      return isDependencyBlocked(info?.status ?? "", info?.blocked);
    }),
  );
  const afterError = blockedAfterRun ? t("after.blockedDraft") : "";
  const capabilities = catalog.data?.capabilities ?? runtime?.capabilities;
  const hasLeverReferences = prompt.references.some(isLeverReference);
  const delegationDefaults = overview.data?.delegationSettings;
  const senderDelegationPolicy = effectiveDelegationPolicy(
    profile,
    delegationDefaults,
  );
  const canQueryRemoteCollaborators =
    visible !== false &&
    !archived &&
    !comparisonAgents &&
    (topicMode || (!session?.parentRunId && !session?.delegatedFrom)) &&
    (senderDelegationPolicy === "all"
      ? allowsRemoteDelegation(profile)
      : senderDelegationPolicy === "selected" &&
        (profile.delegations?.some((rule) => !!rule.deviceId) ?? false));
  const remoteCollaboratorsQuery = useRemoteDelegationTargets({
    chatId: draftAgentId ? undefined : chatId,
    agentId,
    enabled: canQueryRemoteCollaborators,
  });
  const remoteCollaborators = useMemo(
    () =>
      canQueryRemoteCollaborators ? (remoteCollaboratorsQuery.data ?? []) : [],
    [canQueryRemoteCollaborators, remoteCollaboratorsQuery.data],
  );
  const collaboratorIds = useMemo(() => {
    if (!topicMode && (session?.parentRunId || session?.delegatedFrom))
      return [];
    const senders = comparisonAgents
      ? agents.filter((agent) => comparisonAgents.includes(agent.id))
      : [{ id: agentId, profile }];
    return agents
      .filter(
        (target) =>
          !target.archived &&
          canAcceptDelegations(target.profile) &&
          senders.length > 0 &&
          senders.every((sender) => {
            const pol = effectiveDelegationPolicy(
              sender.profile,
              delegationDefaults,
            );
            if (pol === "all") return target.id !== sender.id;
            if (pol === "selected") {
              return sender.profile.delegations?.some(
                (rule) => !rule.deviceId && rule.agentId === target.id,
              );
            }
            return false;
          }),
      )
      .map((agent) => agent.id);
  }, [
    topicMode,
    session?.parentRunId,
    session?.delegatedFrom,
    comparisonAgents,
    agents,
    agentId,
    profile,
    delegationDefaults,
  ]);
  const isRemoteAgentAllowed = (deviceId: string, targetAgentId: string) => {
    if (!topicMode && (session?.parentRunId || session?.delegatedFrom))
      return false;
    const senders = comparisonAgents
      ? agents.filter((agent) => comparisonAgents.includes(agent.id))
      : [{ id: agentId, profile }];
    if (!senders.length) return false;
    return senders.every((sender) => {
      const pol = effectiveDelegationPolicy(sender.profile, delegationDefaults);
      if (pol === "all") return allowsRemoteDelegation(sender.profile);
      if (pol === "selected") {
        return sender.profile.delegations?.some(
          (rule) =>
            rule.deviceId === deviceId && rule.agentId === targetAgentId,
        );
      }
      return false;
    });
  };
  const referenceError =
    hasLeverReferences &&
    (comparisonAgents
      ? participants.some(
          ({ agent, capabilities }) =>
            comparisonAgents.includes(agent.id) && capabilities?.mcp === false,
        )
      : capabilities?.mcp === false)
      ? t("composer.unsupportedReferences")
      : prompt.references.some((ref) => {
            if (ref.kind !== "agent") return false;
            if (ref.deviceId) {
              return !isRemoteAgentAllowed(ref.deviceId, ref.id ?? "");
            }
            return !collaboratorIds.includes(ref.id ?? "");
          })
        ? t("composer.unavailableCollaborator")
        : "";
  const sessionRuntime =
    !comparisonAgents &&
    !topicMode &&
    session?.selection.provider === selection.provider
      ? session.runtime
      : undefined;
  const sessionPermission =
    selection.provider === sessionSelection?.provider
      ? sessionSelection.permission
      : undefined;
  const profilePermission = resolveAgentPermissionForCatalog(
    profile.permission,
    catalog.data,
    runtime?.type,
  );
  const permission =
    mapped.permission ||
    selection.permission ||
    sessionPermission ||
    profilePermission ||
    catalog.data?.defaultPermission ||
    "";
  const send = useMutation({
    mutationKey: ["message", key],
    mutationFn: ({
      input,
    }: {
      input: SendInput | ComparisonInput;
      launchedFromTopicId?: string;
    }): Promise<Run | Comparison> =>
      "agentIds" in input
        ? api<Comparison>("/comparisons", input)
        : api<Run>("/messages", input),
    onSuccess: async (result, { input, launchedFromTopicId }) => {
      if (preview.file) preview.close({ restoreFocus: false });
      const isSessionMessage =
        "operation" in input && input.operation !== "topic";
      // Keep a queued choice while it waits. A steer saves its choice in the
      // session itself, where the queue action can update it too.
      const queuedSelection =
        "selection" in result &&
        result.status === "queued" &&
        !result.steerRunId
          ? result.selection
          : undefined;
      const nextDraft = draft.editing
        ? draft.editing.previous
        : {
            ...draft,
            content: textPrompt(""),
            files: [],
            quote: null,
            workingCopyId: undefined,
            comparisonAgents: undefined,
            comparisonSelection: undefined,
            comparisonModels: undefined,
            comparisonSharedScope: undefined,
            afterRunIds: undefined,
            sessionSelection: isSessionMessage
              ? queuedSelection
              : draft.sessionSelection,
            topicSelection: undefined,
          };
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chat", result.chatId] }),
        session &&
          queryClient.invalidateQueries({ queryKey: ["session", session.id] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      clearSubmission(key);
      setDraft(
        draftAgentId
          ? { ...nextDraft, sessionSelection: undefined }
          : nextDraft,
      );
      if (draftAgentId) saveComposerDraft(result.chatId, nextDraft);
      else if (!reply && !fixedSession) recoverTopicLauncherDraft(chatId);
      if ("operation" in input && input.replaceRunId)
        void queryClient.invalidateQueries({ queryKey: ["message-search"] });
      const root = composerRoot.current;
      if (
        !draftAgentId &&
        root &&
        !root.closest("[inert], [hidden]") &&
        (document.activeElement === document.body ||
          root.contains(document.activeElement))
      )
        textbox.current?.focus();
      onSent(result, launchedFromTopicId);
    },
  });
  const interrupt = useMutation({
    mutationFn: interruptReply,
    onError: (error) => toast.error(error.message),
  });
  const resume = useMutation({
    mutationFn: ({ run, commandId }: { run: Run; commandId?: string }) =>
      recoverRun(run, commandId),
    onSuccess: async (_data, { run }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["chat", chatId] }),
        session &&
          queryClient.invalidateQueries({ queryKey: ["session", session.id] }),
        run.comparisonId
          ? queryClient.invalidateQueries({
              queryKey: ["comparison", run.comparisonId],
            })
          : undefined,
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const resumeUncertain =
    resume.isError &&
    (!(resume.error instanceof APIError) || resume.error.status >= 500);
  const canPause = !!activeRun && canPauseReply(activeRun);
  const interruptLabel = t(
    activeRun?.pauseRequested
      ? "chat.pausingReply"
      : canPause
        ? "chat.pauseReply"
        : "chat.stop",
  );
  function beginEdit(run: Run, sent: boolean) {
    if (sending || uploading || draft.editing || readSubmission(key)) {
      toast.error(t("chat.editUnavailable"));
      return;
    }
    setDraft((current) => ({
      content: messagePrompt(run.input, run.references),
      files: run.attachments,
      sessionSelection: run.selection,
      topic: !sent && run.operation === "topic",
      afterRunIds: !sent && run.afterRunIds?.length ? run.afterRunIds : undefined,
      quote: run.quote ?? null,
      editing: { runId: run.id, previous: current, sent },
    }));
    send.reset();
    requestAnimationFrame(() => textbox.current?.focus("end"));
  }
  function cancelEdit() {
    if (sending || uploading || !draft.editing) return;
    clearSubmission(key);
    setDraft(draft.editing.previous);
    send.reset();
    textbox.current?.focus();
  }
  const beginSentEdit = useEffectEvent((run: Run) => {
    if (archived) return;
    if (run.status === "queued") {
      beginEdit(run, false);
      return;
    }
    if (activeRun) {
      toast.error(t("chat.editWaitForRun"));
      return;
    }
    beginEdit(run, true);
  });
  useEffect(() => {
    if (visible === false) return;
    const insertion = composer?.insertions.get(key);
    if (!composer || !insertion) return;
    if (insertion.kind === "files") {
      if (uploading || sending) return;
      composer.inserted(key, insertion.id);
      void intake(insertion.files);
      return;
    }
    if (insertion.kind === "edit") {
      composer.inserted(key, insertion.id);
      beginSentEdit(insertion.run);
      return;
    }
    if (sending || insertion.kind !== "quote") return;
    setDraft((d) => ({ ...d, quote: insertion.quote }));
    composer.inserted(key, insertion.id);
    requestAnimationFrame(() => textbox.current?.focus());
  }, [composer, key, sending, uploading, visible]);
  const running = Boolean(activeRun && !topicMode);
  const canSendWithPausedQueue = Boolean(
    resumableRun?.status === "paused" && session?.queuePaused,
  );
  const followUp =
    !editingSent &&
    !topicMode &&
    (running || (queuedRuns.length > 0 && !canSendWithPausedQueue));
  const matchingRun =
    running &&
    !draft.editing &&
    !activeRun?.channel &&
    activeRun?.selection.provider === selection.provider
      ? activeRun
      : undefined;
  const livePermissionRun =
    matchingRun?.permissionMutable &&
    (matchingRun.status === "running" || matchingRun.status === "waiting_user")
      ? matchingRun
      : undefined;
  const nextTurnOnly = (permission: string) =>
    catalog.data?.permissions.some(
      (option) => option.id === permission && option.nextTurnOnly,
    );
  const deferPermission =
    livePermissionRun &&
    override &&
    livePermissionRun.selection.permission !== permission;
  const approvalRun =
    matchingRun &&
    (matchingRun.status === "running" ||
      matchingRun.status === "waiting_user") &&
    (matchingRun.selection.permission === "ask" || matchingRun.allowApprovals)
      ? matchingRun
      : undefined;
  const selectPermission = (permission: string) => {
    setSelection({ ...selection, permission });
  };
  const changeRunPermission = useMutation({
    mutationFn: ({ run, ...change }: RunPermissionChange) =>
      api(
        `/runs/${run.id}/${"permission" in change ? "permission" : "approvals"}`,
        change,
      ),
    onSuccess: async (_, change) => {
      const { run } = change;
      if ("permission" in change) {
        setDraft((d) =>
          !d.editing && d.sessionSelection?.provider === run.selection.provider
            ? {
                ...d,
                sessionSelection: {
                  ...d.sessionSelection,
                  permission: change.permission,
                  permissionSource: undefined,
                },
              }
            : d,
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
        queryClient.invalidateQueries({ queryKey: ["session", run.sessionId] }),
      ]);
    },
    onError: (error) =>
      toast.error(t("permissions.changeFailed"), {
        description: error.message,
      }),
  });
  const canSteer =
    !draft.editing &&
    !afterRunIds &&
    !hasLeverReferences &&
    (activeRun?.canSteer || activeRun?.steerPending) &&
    running &&
    !activeRun.channel &&
    activeRun.sessionId === session?.id &&
    ["starting", "running"].includes(activeRun.status) &&
    activeRun.selection.provider === selection.provider &&
    (activeRun.selection.permission || "") === permission;
  const steerHint =
    canSteer && steerModelHint(t, catalog.data, activeRun.selection, selection);
  const goalControl = /^\/goal(?:\s+(status|show|pause|resume|clear))?$/i.exec(
    prompt.text.trim(),
  );
  const liveGoalControl =
    !!goalControl &&
    !draft.quote &&
    !draft.files.length &&
    !prompt.references.length &&
    (runtime?.type === "codex" ||
      (runtime?.type === "claude" &&
        !["pause", "resume"].includes(goalControl[1]?.toLowerCase())));
  const followUpShortcut = liveGoalControl
    ? { primary: "steer" as const, alternate: "queue" as const }
    : shortcuts.followUp;
  const defaultDelivery = followUp
    ? canSteer
      ? followUpShortcut.primary
      : "queue"
    : undefined;
  const alternateDelivery = canSteer ? followUpShortcut.alternate : undefined;
  const defaultAction = defaultDelivery && followUpActions[defaultDelivery];
  const alternateAction =
    alternateDelivery && followUpActions[alternateDelivery];
  const actionLabel = (action: (typeof followUpActions)["steer" | "queue"]) =>
    t(
      action === followUpActions.steer && activeRun?.steerPending
        ? "queue.steerWhenReady"
        : action.label,
    );
  const editLabel = editingSent ? "chat.resendEdit" : "queue.save";
  const sendLabel = comparisonAgents
    ? t("comparison.send", { count: comparisonAgents.length })
    : !draft.editing && afterRunIds?.length
      ? t("after.send", { count: afterRunIds.length })
      : !draft.editing && defaultAction
        ? actionLabel(defaultAction)
        : t(draft.editing ? editLabel : "chat.send");
  const sendButtonText =
    draft.editing || comparisonAgents
      ? sendLabel
      : afterRunIds !== undefined
        ? t("after.sendShort")
        : defaultAction && t(defaultAction.shortLabel);
  const promptEmpty = !prompt.text.trim() && !prompt.references.length;
  const hasContent = !promptEmpty || draft.files.length > 0 || !!draft.quote;
  const canResume = Boolean(
    resumableRun &&
      !running &&
      !topicMode &&
      !hasContent &&
      !draft.editing &&
      !comparisonAgents &&
      afterRunIds === undefined &&
      !archived &&
      !resumableRun.channel,
  );
  const hasInput = hasContent || !!draft.editing || uploading || sending;
  useEffect(() => {
    if (hasInput) keepOpen?.();
  }, [hasInput, keepOpen]);
  const modelError = runtimeUnavailable
    ? t("composer.runtimeDisabled")
    : modelUnavailable && !replaySelection
      ? t("composer.modelUnavailable")
      : "";
  const imageError = !capabilities?.images
    ? t("composer.unsupportedImages")
    : model?.images === false
      ? t("composer.modelUnsupportedImages")
      : "";
  const singleRootParticipant =
    comparisonAgents && !replayComparison
      ? participants.find(
          ({ agent, selection, capabilities }) =>
            selection &&
            comparisonAgents.includes(agent.id) &&
            capabilities?.multiRoot === false &&
            !capabilities.directoryContext &&
            (shareScope ? currentScope : agent.profile).roots.length > 1,
        )
      : undefined;
  const unsupported =
    referenceError ||
    (singleRootParticipant &&
      t("comparison.unsupportedRoots", {
        name: singleRootParticipant.agent.name,
      })) ||
    (comparisonAgents
      ? ""
      : modelError ||
        (catalog.data && capabilities
          ? imageError &&
            draft.files.some((file) => file.mediaType.startsWith("image/"))
            ? imageError
            : draft.files.some(
                  (file) => !file.mediaType.startsWith("image/"),
                ) && !capabilities.files
              ? t("composer.unsupportedFiles")
              : currentScope.roots.length > 1 &&
                  !capabilities.multiRoot &&
                  !capabilities.directoryContext
                ? t("composer.unsupportedRoots")
                : (profile.skills?.length ?? 0) > 0 && !capabilities.skills
                  ? t("composer.unsupportedSkills")
                  : ""
          : ""));
  const scopePath = (path: string) =>
    path.replace(/\\/g, "/").replace(/\/$/, "");
  const staleFiles = prompt.references.some(
    (ref) =>
      ref.kind === "file" &&
      !currentScope.roots.some((root) => {
        const prefix = scopePath(root.path);
        return scopePath(ref.path).startsWith(`${prefix}/`);
      }),
  );
  const directoryError =
    copyId && !copyAvailable && !copies.isPending
      ? t("worktrees.unavailable")
      : staleFiles && (!comparisonAgents || (shareScope && !replayComparison))
        ? t("worktrees.references")
        : "";
  const hasModel =
    !checkingPreference &&
    !mapped.pending &&
    Boolean(
      replaySelection ||
      selection.model ||
      catalog.data?.models.some((model) => model.id === "" && model.default),
    );
  const needsRuntimeSetup =
    !archived &&
    !comparisonAgents &&
    (runtimeUnavailable ||
      catalog.data === null ||
      (catalog.isError && !hasModel));
  const canSend =
    hasContent &&
    !unsupported &&
    !directoryError &&
    !afterError &&
    (afterRunIds === undefined || afterRunIds.length > 0) &&
    (!copyId || copyAvailable) &&
    (comparisonAgents
      ? comparisonAgents.length >= 2 &&
        comparisonAgents.length <= MaxComparisonAgents &&
        (!!replayComparison ||
          comparisonAgents.every((id) => comparisonSelections[id]))
      : hasModel) &&
    !sending &&
    !changeRunPermission.isPending &&
    !uploading &&
    !archived &&
    (!editingSent || !activeRun) &&
    (!running || activeRun?.status !== "unknown" || !!draft.editing);
  function submit(alternate = false) {
    if (!canSend) return;
    const pending = readSubmission(key);
    if (launchTopic && !draft.topic) setDraft((d) => ({ ...d, topic: true }));
    if (comparisonMessage) {
      const input: ComparisonInput = replayComparison ?? {
        commandId: crypto.randomUUID(),
        ...comparisonMessage,
        selections: comparisonSelections,
      };
      saveSubmission(key, input);
      // Freeze resolved defaults too, so a later edit or retry starts from what was sent.
      if (!replayComparison)
        setDraft((d) => ({ ...d, comparisonModels: input.selections }));
      send.mutate({ input });
      return;
    }
    const previousSend =
      pending && "operation" in pending ? pending : undefined;
    const delivery =
      (alternate ? alternateDelivery : undefined) ?? defaultDelivery;
    const nextSelection =
      replaySelection ??
      (permission && permission !== selection.permission
        ? { ...selection, permission }
        : selection);
    const input: SendInput = {
      sharedScope,
      commandId: previousSend?.commandId ?? crypto.randomUUID(),
      chatId: draftAgentId ? "" : chatId,
      ...(draftAgentId ? { agentId: draftAgentId } : {}),
      sessionId: reply ? session?.id : undefined,
      operation,
      // A retry keeps its original delivery even if the preference has changed.
      delivery: previousSend ? previousSend.delivery : delivery,
      steerRunId: previousSend
        ? previousSend.steerRunId
        : delivery === "steer"
          ? activeRun?.id
          : undefined,
      ...(afterRunIds?.length ? { afterRunIds } : {}),
      ...(replaceRunId
        ? { replaceRunId }
        : { editRunId: draft.editing?.runId }),
      ...(copyId ? { workingCopyId: copyId } : {}),
      text: prompt.text,
      selection: nextSelection,
      attachmentIds: draft.files.map((file) => file.id),
      ...(prompt.references.length ? { references: prompt.references } : {}),
      ...(draft.quote ? { quote: draft.quote } : {}),
    };
    if (
      previousSend &&
      JSON.stringify(input) !== JSON.stringify(previousSend)
    ) {
      input.commandId = crypto.randomUUID();
      input.delivery = delivery;
      input.steerRunId = delivery === "steer" ? activeRun?.id : undefined;
    }
    saveSubmission(key, input);
    if (override && !replaySelection && override !== nextSelection)
      setSelection(nextSelection);
    send.mutate({
      input,
      launchedFromTopicId:
        operation === "topic" && !draft.editing
          ? topicLauncher?.topicId
          : undefined,
    });
  }
  async function intake(files: File[]): Promise<number> {
    if (!files.length || intakeBusy.current || sending || archived) return 0;
    if (files.length + draft.files.length > MAX_ATTACHMENT_COUNT) {
      toast.error(t("attachments.countLimit"));
      return 0;
    }
    if (
      files.reduce((n, f) => n + f.size, 0) +
        draft.files.reduce((n, f) => n + f.size, 0) >
      MAX_ATTACHMENT_TOTAL_BYTES
    ) {
      toast.error(t("attachments.sizeLimit"));
      return 0;
    }
    intakeBusy.current = true;
    setUploading(true);
    let added = 0;
    try {
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        try {
          const saved = await api<Attachment>(
            draftAgentId
              ? `/agents/${draftAgentId}/attachments`
              : `/chats/${chatId}/attachments`,
            body,
          );
          setDraft((d) => ({ ...d, files: [...d.files, saved] }));
          added += 1;
        } catch (error) {
          toast.error(
            `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      intakeBusy.current = false;
      setUploading(false);
      textbox.current?.focus();
    }
    return added;
  }
  function foldPastedText(
    text: string,
    { wouldExceedInputLimit }: { wouldExceedInputLimit: boolean },
  ): boolean {
    const filesSupported = comparisonAgents
      ? true
      : capabilities?.files !== false;
    const canStage =
      !archived &&
      !sending &&
      !uploading &&
      !intakeBusy.current &&
      filesSupported &&
      draft.files.length < MAX_ATTACHMENT_COUNT;
    if (!canStage) {
      if (!wouldExceedInputLimit) return false;
      toast.error(t("attachments.pasteTooLargeForMessage"));
      return true;
    }
    const fileName = nextPastedTextFileName(
      draft.files.map((file) => file.name),
    );
    const file = new File([text], fileName, {
      type: "text/plain;charset=utf-8",
    });
    const existingBytes = draft.files.reduce((sum, item) => sum + item.size, 0);
    if (existingBytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      if (!wouldExceedInputLimit) return false;
      toast.error(t("attachments.sizeLimit"));
      return true;
    }
    void intake([file]).then((added) => {
      if (added > 0) {
        toast(
          wouldExceedInputLimit
            ? t("attachments.pastedAsFileLimit")
            : t("attachments.pastedAsFile", {
                shortcut: formatShortcut(pasteAsTextShortcut),
              }),
        );
      }
    });
    return true;
  }
  async function remove(file: Attachment) {
    try {
      await api(`/attachments/${file.id}`, {}, "DELETE");
    } catch (error) {
      if (!(error instanceof APIError && error.status === 409)) {
        toast.error(String(error));
        return;
      }
    }
    if (preview.file?.id === file.id) preview.close();
    setDraft((d) =>
      d.editing?.runId === draft.editing?.runId
        ? { ...d, files: d.files.filter((f) => f.id !== file.id) }
        : d,
    );
  }
  function chooseCommand(command: ComposerCommand) {
    if (command === "model") {
      setModelOpen(true);
    } else if (command === "compare") {
      if (comparisonAgents) {
        setDraft((d) => ({
          ...d,
          comparisonAgents: undefined,
          comparisonModels: undefined,
        }));
      } else if (canStartComparison) {
        setDraft((d) => ({
          ...d,
          topic: true,
          afterRunIds: undefined,
          comparisonSelection: {
            ...selection,
            permission: permission || undefined,
          },
          comparisonAgents: runtimeUnavailable ? [] : [agentId],
          comparisonModels: undefined,
          comparisonSharedScope: undefined,
        }));
      }
    } else if (command === "after") {
      if (afterRunIds !== undefined) {
        setDraft((d) => ({ ...d, afterRunIds: undefined }));
      } else if (canStartAfter) {
        const preselected = defaultWaitRunIds(waitCandidates);
        setAfterPickerKey((n) => n + 1);
        setDraft((d) => ({
          ...d,
          topic: reply || fixedSession || d.editing || topicLauncher ? d.topic : true,
          comparisonAgents: undefined,
          comparisonModels: undefined,
          afterRunIds: preselected,
        }));
      }
    } else if (!editingSent && !topicLauncher && !fixedSession) {
      setDraft((d) => ({
        ...d,
        topic: command === "topic",
        comparisonAgents: undefined,
        comparisonModels: undefined,
      }));
    }
  }
  return (
    <div
      ref={composerRoot}
      data-composer-compact={compact || undefined}
      onCompositionStart={keepOpen}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (
          !(next instanceof globalThis.Node) ||
          !event.currentTarget.contains(next)
        ) {
          notifyTyping(scopeSession?.id, false);
        }
      }}
      onDragEnter={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (!canDropFiles) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        event.dataTransfer.dropEffect = "copy";
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = canDropFiles ? "copy" : "none";
        if (canDropFiles && !dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (dragDepth.current <= 0 && !dragging) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        const next = event.relatedTarget;
        if (
          dragDepth.current <= 0 ||
          (next instanceof globalThis.Node &&
            !event.currentTarget.contains(next))
        ) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!canDropFiles) return;
        const { files, skippedDirectories } = extractDroppedFiles(
          event.dataTransfer,
        );
        if (skippedDirectories > 0) {
          toast.error(t("attachments.directoryUnsupported"));
        }
        if (files.length) void intake(files);
      }}
    >
      {!topicMode && (
        <QueuedMessages
          runs={queuedRuns}
          activeRun={activeRun}
          queuePaused={session?.queuePaused}
          catalog={catalog.data}
          allowTopicBranch={!fixedSession}
          disabled={sending || uploading || archived || !!readSubmission(key)}
          editing={draft.editing?.runId}
          onEdit={(run) => beginEdit(run, false)}
          onTopicCreated={(run) => {
            if (
              reply &&
              appPreferences.openNewTopicOnCreate &&
              onOpenHandoffTopic
            ) {
              onOpenHandoffTopic(run);
            } else {
              toast.success(
                t("chat.topicCreated"),
                onOpenHandoffTopic
                  ? {
                      action: {
                        label: t("queue.openTopic"),
                        onClick: () => onOpenHandoffTopic(run),
                      },
                    }
                  : undefined,
              );
            }
          }}
          onSteer={(run) =>
            setDraft((d) => {
              const choice = d.sessionSelection;
              return choice &&
                choice.provider === run.selection.provider &&
                choice.permission === run.selection.permission &&
                !hasDifferentModelSettings(choice, run.selection)
                ? { ...d, sessionSelection: undefined }
                : d;
            })
          }
        />
      )}
      <InputGroup
        className={cn(
          "composer",
          (reply || fixedSession) && "topic-composer",
          topicLauncher && "composer-topic-launcher",
          dragging && "is-dragging",
        )}
      >
        {(draft.files.length > 0 ||
          draft.editing ||
          send.error ||
          unsupported ||
          needsRuntimeSetup ||
          directoryError ||
          afterError ||
          draft.quote) && (
          <InputGroupAddon
            align="block-start"
            className="flex-col items-stretch gap-3"
          >
            <Attachments
              files={draft.files}
              fileLinksOnly={capabilities?.fileLinksOnly}
              onRemove={sending ? undefined : (file) => void remove(file)}
            />
            {draft.editing && (
              <div className="queue-heading">
                <div>
                  <span>
                    {t(editingSent ? "chat.editingSent" : "queue.editing")}
                  </span>
                  {editingSent && (
                    <p className="mt-1 text-xs font-normal leading-normal">
                      {t(
                        activeRun
                          ? "chat.editWaitForRun"
                          : "chat.editConsequence",
                      )}
                    </p>
                  )}
                </div>
                <InputGroupButton
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t(
                    editingSent ? "chat.cancelEdit" : "queue.cancelEdit",
                  )}
                  disabled={sending || uploading}
                  onClick={cancelEdit}
                >
                  <X />
                </InputGroupButton>
              </div>
            )}
            {draft.quote && (
              <div className="composer-quote">
                <QuotedMessage
                  quote={draft.quote}
                  onRemove={
                    sending
                      ? undefined
                      : () => {
                          setDraft((d) => ({ ...d, quote: null }));
                          textbox.current?.focus();
                        }
                  }
                />
              </div>
            )}
            {send.error && <ErrorNotice error={send.error} />}
            {directoryError && (
              <p className="reference-error" role="alert">
                {directoryError}
              </p>
            )}
            {afterError && (
              <p className="reference-error" role="alert">
                {afterError}
              </p>
            )}
            {unsupported && (
              <p className="reference-error" role="alert">
                {unsupported}
              </p>
            )}
            {needsRuntimeSetup && (
              <div className="flex flex-wrap items-center gap-2">
                {!runtimeUnavailable &&
                  (catalog.isError ? (
                    <ErrorNotice error={catalog.error} />
                  ) : (
                    <span
                      className="text-xs text-muted-foreground"
                      role="status"
                    >
                      {t("models.runtimeNotFound")}
                    </span>
                  ))}
                {configureRuntime && (
                  <InputGroupButton
                    variant="outline"
                    onClick={configureRuntime}
                  >
                    {t("connections.manage")}
                  </InputGroupButton>
                )}
              </div>
            )}
          </InputGroupAddon>
        )}
        {comparisonAgents && (
          <InputGroupAddon align="block-start">
            <ComparisonPicker
              participants={participants}
              selected={comparisonAgents}
              disabled={sending}
              providers={providers}
              onReturnToComposer={() => textbox.current?.focus()}
              onModelChange={(id, choice) =>
                setDraft((d) => ({
                  ...d,
                  comparisonModels: {
                    ...replayComparison?.selections,
                    ...d.comparisonModels,
                    [id]: choice,
                  },
                }))
              }
              onChange={(comparisonAgents) =>
                setDraft((d) => ({
                  ...d,
                  comparisonAgents,
                  comparisonModels: Object.fromEntries(
                    Object.entries({
                      ...replayComparison?.selections,
                      ...d.comparisonModels,
                    }).filter(([id]) => comparisonAgents.includes(id)),
                  ),
                }))
              }
            />
          </InputGroupAddon>
        )}
        {afterRunIds !== undefined && (
          <InputGroupAddon align="block-start">
            <WaitRunPicker
              key={afterPickerKey}
              candidates={waitCandidates}
              selected={afterRunIds}
              resolved={resolvedAfterRuns}
              disabled={sending}
              initialOpen={afterRunIds.length === 0}
              onChange={(next) => setDraft((d) => ({ ...d, afterRunIds: next }))}
              onReturnToComposer={() => textbox.current?.focus()}
            />
          </InputGroupAddon>
        )}
        {sessionRuntime?.goal && (
          <InputGroupAddon
            align="block-start"
            className="min-w-0 text-xs text-muted-foreground"
          >
            <span className="truncate" title={sessionRuntime.goal.objective}>
              {t("composer.goal", {
                status: t(`composer.goalStatus.${sessionRuntime.goal.status}`, {
                  defaultValue: sessionRuntime.goal.status,
                }),
                objective: sessionRuntime.goal.objective,
              })}
            </span>
          </InputGroupAddon>
        )}
        <ComposerInput
          autoFocus={autoFocus}
          onEscape={
            preview.file
              ? preview.close
              : draft.editing && !sending && !uploading
                ? cancelEdit
                : undefined
          }
          empty={promptEmpty}
          textbox={textbox}
          chatId={chatId}
          draftAgentId={draftAgentId}
          sessionId={scopeSession?.id}
          workingCopyId={copyId}
          provider={inputProvider}
          nativeCommands={{
            session: sessionRuntime?.commands,
            catalog: catalog.data?.commands,
          }}
          commandText={
            !draft.quote && !draft.files.length && !prompt.references.length
              ? prompt.text.trim()
              : undefined
          }
          goal={sessionRuntime?.goal}
          runtimeType={
            providers?.find((item) => item.id === inputProvider)?.type
          }
          actions={{
            id: actionsId,
            browser: actionMenu,
            navigate: setActionMenu,
            attach: () => fileInput.current?.click(),
            runApprovals:
              approvalRun && !changeRunPermission.isPending
                ? {
                    allowed: Boolean(approvalRun.allowApprovals),
                    toggle: () =>
                      changeRunPermission.mutate({
                        run: approvalRun,
                        allow: !approvalRun.allowApprovals,
                      }),
                  }
                : undefined,
          }}
          scopeKey={JSON.stringify([
            currentScope.roots,
            currentScope.primaryRootId,
            profile.skills,
            profile.disabledSkills,
          ])}
          reply={reply}
          fixedDestination={editingSent || !!topicLauncher || !!fixedSession}
          useAgentProfiles={!!comparisonAgents}
          canStartComparison={canStartComparison}
          canStartAfter={canStartAfter}
          waitingForRuns={afterRunIds !== undefined}
          collaboratorIds={collaboratorIds}
          remoteCollaborators={remoteCollaborators}
          onCommand={chooseCommand}
          label={t(
            reply
              ? "chat.reply"
              : topicLauncher && topicMode
                ? "chat.newTopicDestination"
                : "chat.message",
          )}
          placeholder={
            reply
              ? t("chat.replyPlaceholder")
              : comparisonAgents
                ? t("comparison.placeholder")
                : topicMode
                  ? t("chat.topicPlaceholder")
                  : t("chat.placeholder")
          }
          value={draft.content}
          onChange={(content) => {
            keepOpen?.();
            setDraft((d) => ({ ...d, content, topic: launchTopic || d.topic }));
            if (hasActiveDelegations && scopeSession?.id && !topicMode) {
              const serialized = serializePrompt(content);
              const nonEmpty =
                Boolean(serialized.text.trim()) ||
                serialized.references.length > 0;
              notifyTyping(scopeSession.id, nonEmpty);
            }
          }}
          disabled={sending}
          visible={visible}
          onFiles={(files) => void intake(files)}
          onPasteLargeText={foldPastedText}
          onSubmit={submit}
        />
        {compact && backToMessagesButton}
        <div
          className="composer-action-space"
          data-align="block-end"
          inert={compact || undefined}
        >
          <div className="composer-action-clip">
            <InputGroupAddon
              align="block-end"
              className="composer-actions"
              data-comparing={Boolean(comparisonAgents) || undefined}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (
                  event.currentTarget.contains(target) &&
                  !target.closest("button")
                )
                  textbox.current?.focus();
              }}
            >
              <div className="composer-tools">
                <input
                  ref={fileInput}
                  className="sr-only"
                  type="file"
                  multiple
                  tabIndex={-1}
                  aria-label={t("attachments.choose")}
                  onChange={(event) => {
                    void intake(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <InputGroupButton
                  variant="ghost"
                  size="icon-sm"
                  id={actionsId}
                  className="composer-actions-trigger rounded-full"
                  aria-label={t("composer.actions")}
                  title={t("composer.actions")}
                  aria-haspopup="dialog"
                  aria-expanded={!!actionMenu}
                  aria-controls={actionMenu ? `${actionsId}-panel` : undefined}
                  disabled={actionsDisabled}
                  onClick={() =>
                    setActionMenu((open) =>
                      open ? null : { page: "actions", query: "" },
                    )
                  }
                >
                  {uploading ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                </InputGroupButton>
                {!compact && backToMessagesButton}
                {!reply && !fixedSession && !topicLauncher && !editingSent && (
                  <MotionInputGroupButton
                    variant="ghost"
                    size="sm"
                    className="composer-mode-button"
                    layout
                    layoutDependency={draft.topic}
                    transition={{ duration: reduceMotion ? 0 : 0.16 }}
                    aria-label={t("chat.topic")}
                    aria-pressed={draft.topic}
                    title={
                      draft.topic
                        ? t("composer.command.chat")
                        : t("composer.command.topic")
                    }
                    disabled={sending}
                    onClick={() => {
                      chooseCommand(draft.topic ? "chat" : "topic");
                      textbox.current?.focus();
                    }}
                  >
                    <AnimatePresence initial={false} mode="popLayout">
                      <motion.span
                        key={draft.topic ? "topic" : "chat"}
                        className="composer-mode-label"
                        layout
                        layoutDependency={draft.topic}
                        initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                        transition={{ duration: reduceMotion ? 0 : 0.14 }}
                      >
                        {draft.topic ? (
                          <MessagesCircle data-icon="inline-start" />
                        ) : (
                          <MessageCircle data-icon="inline-start" />
                        )}
                        <span className="composer-action-detail">
                          {t(draft.topic ? "chat.topic" : "workspace.chat")}
                        </span>
                      </motion.span>
                    </AnimatePresence>
                  </MotionInputGroupButton>
                )}
                {comparisonAgents && (
                  <>
                    <InputGroupButton
                      variant="ghost"
                      size="icon-sm"
                      className="bg-control-selected text-foreground"
                      aria-label={t("comparison.title")}
                      aria-pressed={true}
                      title={t("comparison.cancel")}
                      disabled={sending}
                      onClick={() => {
                        chooseCommand("compare");
                        textbox.current?.focus();
                      }}
                    >
                      <Columns2 />
                    </InputGroupButton>
                    <Toggle
                      variant="outline"
                      className="min-w-0 text-muted-foreground aria-pressed:text-foreground"
                      aria-label={t("comparison.sharedScope")}
                      title={[
                        t("comparison.sharedScope"),
                        primaryDirectory(session ?? profile),
                      ].join("\n")}
                      pressed={shareScope}
                      disabled={sending}
                      onPressedChange={(comparisonSharedScope) =>
                        setDraft((d) => ({ ...d, comparisonSharedScope }))
                      }
                    >
                      {shareScope ? (
                        <Folder data-icon="inline-start" />
                      ) : (
                        <Folders data-icon="inline-start" />
                      )}
                      <span className="composer-action-detail truncate">
                        {t("comparison.sharedScope")}
                      </span>
                    </Toggle>
                  </>
                )}
                {afterRunIds !== undefined && (
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    className="bg-control-selected text-foreground"
                    aria-label={t("after.title")}
                    aria-pressed={true}
                    title={t("after.cancel")}
                    disabled={sending}
                    onClick={() => {
                      chooseCommand("after");
                      textbox.current?.focus();
                    }}
                  >
                    <Clock />
                  </InputGroupButton>
                )}
                {choosingDirectory && !archived && (
                  <WorkingDirectoryPicker
                    copies={copies.data}
                    originalPath={primaryDirectory(profile)}
                    selected={copyId}
                    disabled={sending}
                    onSelect={(workingCopyId) =>
                      setDraft((draft) => ({ ...draft, workingCopyId }))
                    }
                  />
                )}
              </div>
              <div className="composer-submit">
                {!comparisonAgents && (
                  <>
                    {appPreferences.showContextUsage &&
                      !topicMode &&
                      !editingSent &&
                      !archived &&
                      !draftAgentId &&
                      session &&
                      sessionRuntime?.context && (
                        <ContextMeter context={sessionRuntime.context} />
                      )}
                    <PermissionMenu
                      providerType={runtime?.type}
                      permissions={catalog.data?.permissions}
                      legacyPermissions={catalog.data?.legacyPermissions}
                      value={
                        (!deferPermission &&
                          livePermissionRun?.selection.permission) ||
                        permission
                      }
                      onChange={(permission) => {
                        if (livePermissionRun && !nextTurnOnly(permission))
                          changeRunPermission.mutate({
                            run: livePermissionRun,
                            permission,
                          });
                        else selectPermission(permission);
                      }}
                      disabled={sending || archived}
                      pending={changeRunPermission.isPending}
                      nextTurn={
                        running && (!livePermissionRun || !!deferPermission)
                      }
                      activeValue={matchingRun?.selection.permission}
                      autoApproving={approvalRun?.allowApprovals}
                    />
                    <ModelPicker
                      key={draft.editing?.runId ?? selectionField}
                      providers={providers}
                      catalog={catalog}
                      cwd={cwd}
                      open={modelOpen}
                      onOpenChange={setModelOpen}
                      onReturnToComposer={() => textbox.current?.focus()}
                      onConfigureRuntime={configureRuntime}
                      value={selection}
                      preferFavorites={preferFavorites}
                      effortHabit={preferences?.effortHabit}
                      selectionForProvider={selectionForProvider}
                      onChange={(next, fromFavorites, meta) => {
                        const hasExplicitPermission = Boolean(
                          sessionSelection?.permission || override?.permission,
                        );
                        const source =
                          next.provider !== selection.provider
                            ? hasExplicitPermission
                              ? (permissionSource ?? {
                                  provider: selection.provider,
                                  permission,
                                })
                              : undefined
                            : permissionSource;
                        setSelection(next, source, meta?.effortSource);
                        if (!meta?.effortSource) {
                          rememberModel(
                            agentId,
                            next,
                            fromFavorites,
                            meta?.modelEfforts,
                          );
                          if (!draft.editing) {
                            void persistAgentSelection(agentId, next);
                          }
                        } else if (!draft.editing) {
                          void persistAgentSelection(agentId, next);
                        }
                      }}
                      disabled={sending || changeRunPermission.isPending}
                    />
                  </>
                )}
                {running && activeRun && activeRun.status !== "unknown" && (
                  <InputGroupButton
                    className="send-button rounded-full"
                    variant={hasContent ? "ghost" : "default"}
                    size="icon-sm"
                    aria-label={interruptLabel}
                    title={interruptLabel}
                    disabled={
                      interrupt.isPending || activeRun.status === "cancelling"
                    }
                    onClick={() => interrupt.mutate(activeRun)}
                  >
                    {canPause ? (
                      <Pause fill="currentColor" />
                    ) : (
                      <Square fill="currentColor" />
                    )}
                  </InputGroupButton>
                )}
                {hasContent && alternateAction && (
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label={actionLabel(alternateAction)}
                    title={[
                      t("settings.followUpShortcutHint", {
                        action: actionLabel(alternateAction),
                        shortcut: shortcuts.alternate,
                      }),
                      alternateDelivery === "steer" && steerHint,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                    disabled={!canSend}
                    onClick={() => submit(true)}
                  >
                    <alternateAction.Icon />
                  </InputGroupButton>
                )}
                {canResume && resumableRun && (
                  <InputGroupButton
                    className="send-button rounded-full"
                    variant="default"
                    size="icon-sm"
                    aria-label={t("chat.resumeReply")}
                    title={t("chat.resumeReply")}
                    disabled={resume.isPending || sending}
                    onClick={() =>
                      resume.mutate({
                        run: resumableRun,
                        commandId:
                          resumableRun.status === "paused"
                            ? undefined
                            : (resumeUncertain &&
                                resume.variables?.run.id === resumableRun.id &&
                                resume.variables.commandId) ||
                              crypto.randomUUID(),
                      })
                    }
                  >
                    {resume.isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Play fill="currentColor" className="translate-x-[0.5px]" />
                    )}
                  </InputGroupButton>
                )}
                {((!running && !canResume) || hasContent || draft.editing) && (
                  <InputGroupButton
                    className="send-button rounded-full"
                    variant="default"
                    size={sendButtonText ? "sm" : "icon-sm"}
                    aria-label={sendLabel}
                    title={[
                      t("settings.composerShortcutHint", {
                        action: sendLabel,
                        shortcut: shortcuts.send,
                        newline: shortcuts.newline,
                      }),
                      defaultDelivery === "steer" && steerHint,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                    disabled={!canSend}
                    onClick={(event) => submit(event.metaKey || event.ctrlKey)}
                  >
                    {sending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : draft.editing ? (
                      <Check />
                    ) : defaultAction ? (
                      <defaultAction.Icon />
                    ) : (
                      <ArrowUp strokeWidth={2.3} />
                    )}
                    {sendButtonText && (
                      <span className="composer-action-detail">
                        {sendButtonText}
                      </span>
                    )}
                  </InputGroupButton>
                )}
              </div>
            </InputGroupAddon>
          </div>
        </div>
        {dragging && (
          <div className="attachment-drop">
            <Upload size={compact ? 16 : 24} />
            <span>{t("attachments.drop")}</span>
          </div>
        )}
      </InputGroup>
    </div>
  );
}
