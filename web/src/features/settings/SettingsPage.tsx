import { useEffect, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  Copy,
  FolderOpen,
  HardDrive,
  Keyboard,
  Monitor,
  Moon,
  Plug,
  RotateCcw,
  Search,
  Settings2,
  Sun,
  TrendingUp,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Agent, Overview } from "@/api/types.gen";
import { Dialogs, Notifications } from "@/api/desktop.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { changeLanguage, languages } from "@/i18n";
import type { Theme } from "@/hooks/useTheme";
import {
  agentSidebarLayouts,
  chatFontSizes,
  chatWidths,
  followUpBehaviors,
  isWorkspaceTabLimit,
  sendShortcuts,
  useComposerShortcuts,
  usePreferences,
} from "./Preferences";
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsRow,
} from "./SettingsControls";
import { ShortcutSettings, shortcutGroups } from "./ShortcutSettings";
import { isMac } from "./shortcuts";
import { SecondarySidebar } from "@/components/workbench/SecondarySidebar";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { hasDesktopNotifications } from "@/features/agents/desktopNotifications";
import { useProviders } from "@/features/runtime/queries";
import { AutomationTimePicker } from "@/features/automations/AutomationTimePicker";
import {
  defaultReminderChoiceOffsets,
  defaultReminderSettings,
  formatShortReminderOffset,
  useSaveTaskReminderSettings,
  useTaskReminderSettings,
} from "@/features/tasks/taskDeadlines";
import {
  defaultTaskDispatchSettings,
  taskChatModes,
  useSaveTaskDispatchSettings,
  useTaskDispatchSettings,
} from "@/features/tasks/taskDispatchSettings";
import {
  defaultDelegationSettings,
  useDelegationSettings,
  useSaveDelegationSettings,
} from "@/features/agents/delegationPolicy";
import {
  defaultPermissionSettings,
  usePermissionSettings,
  useSavePermissionSettings,
} from "@/features/runtime/permissionSettings";
import { RemoteDevices } from "./RemoteDevices";
import { NotesDirectorySetting } from "./NotesDirectorySetting";
import { SettingsProviders } from "./SettingsProviders";
import { UpdatesSettings } from "./UpdatesSettings";
import type { DesktopUpdatesController } from "./useDesktopUpdates";
import { UsageStatsPage } from "@/features/usage/UsageStatsPage";

const sectionGroups = [
  {
    id: "preferences",
    sections: [
      {
        id: "general",
        icon: Settings2,
        fields: [
          "interface",
          "appearance",
          "theme",
          "themeDescription",
          "system",
          "light",
          "dark",
          "language",
          "languageDescription",
          "conversation",
          "sendShortcut",
          "sendShortcutDescription",
          "followUpBehavior",
          "followUpBehaviorDescription",
          "chatFontSize",
          "chatFontSizeDescription",
          "chatWidth",
          "chatWidthDescription",
          "showContextUsage",
          "showContextUsageDescription",
          "workbench",
          "taskChatMode",
          "taskChatModeDescription",
          "taskChatMode.single",
          "taskChatMode.bySource",
          "taskChatMode.newChat",
          "openNewTopicOnCreate",
          "openNewTopicOnCreateDescription",
          "agentListLayout",
          "agentListLayoutDescription",
          "agentListLayout.single",
          "agentListLayout.two-line",
          "agentActivity",
          "agentActivityDescription",
          "maxWorkspaceTabs",
          "maxWorkspaceTabsDescription",
          "notifications",
          ...(hasDesktopNotifications
            ? ["desktopNotifications", "desktopNotificationsDescription"]
            : []),
          "taskReminders",
          "defaultTaskReminder",
          "defaultTaskReminderDescription",
          "allDayReminderTime",
          "allDayReminderTimeDescription",
          "agentDefaults",
          "agentDefaultsDescription",
          "defaultDelegationPolicy",
          "defaultDelegationPolicyDescription",
          "nestedDelegation",
          "nestedDelegationDescription",
          "permissions",
          "permissionsDescription",
          "defaultPermissionMode.auto",
          "defaultPermissionMode.yolo",
        ],
      },
      { id: "providers", icon: Plug, fields: [] },
 { id: "remoteDevices", icon: Monitor, fields: [] },
      {
        id: "shortcuts",
        icon: Keyboard,
        fields: [
          "sendMessage",
          "queueMessage",
          "steerMessage",
          "newLine",
          "suggestions",
          "chooseSuggestion",
        ],
      },
    ],
  },
  {
    id: "system",
    sections: [
      {
        id: "usageStats" as const,
        icon: TrendingUp,
        fields: ["usageStatsDescription"],
      },
      ...(isMyGo()
        ? [
            {
              id: "updates" as const,
              icon: ArrowDownToLine,
              fields: [
                "updatesVersion",
                "updatesDescription",
                "updatesCheck",
                "updatesPreferences",
                "updatesAutoCheck",
                "updatesAutoCheckDescription",
                "updatesAutoDownload",
                "updatesAutoDownloadDescription",
                "updatesPrereleases",
                "updatesPrereleasesDescription",
              ],
            },
          ]
        : []),
      {
        id: "storage" as const,
        icon: HardDrive,
        fields: [
          "dataDir",
          "dataDirDescription",
          "notesDirectory",
          "notesDirectoryDescription",
          "workspaceData",
          "localPreferences",
          "localPreferencesDescription",
        ],
      },
      {
        id: "archivedAgents" as const,
        icon: Archive,
        fields: ["archivedAgentsDescription"],
      },
    ],
  },
] as const;
type Section = (typeof sectionGroups)[number]["sections"][number]["id"];

function WorkspaceTabLimitSetting({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>();
  const text = draft?.trim() ?? "";
  const limit = text ? Number(text) : null;
  const invalid =
    limit !== null && (!/^\d+$/.test(text) || !isWorkspaceTabLimit(limit));
  const id = "settings-max-workspace-tabs";

  return (
    <SettingsRow
      id={id}
      title={t("settings.maxWorkspaceTabs")}
      description={t("settings.maxWorkspaceTabsDescription")}
    >
      <div className="flex flex-col gap-1">
        <Input
          id={id}
          className="w-28 tabular-nums"
          inputMode="numeric"
          placeholder={t("settings.unlimitedWorkspaceTabs")}
          aria-describedby={
            invalid ? `${id}-description ${id}-error` : `${id}-description`
          }
          aria-invalid={invalid || undefined}
          value={draft ?? (value === null ? "" : String(value))}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={() => {
            if (draft === undefined || invalid) return;
            setDraft(undefined);
            if (limit !== value) onChange(limit);
          }}
        />
        {invalid && (
          <FieldError id={`${id}-error`} className="text-xs">
            {t("settings.invalidMaxWorkspaceTabs")}
          </FieldError>
        )}
      </div>
    </SettingsRow>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(value),
    onSuccess: () => toast(t("settings.copied")),
    onError: (error) => toast.error(error.message),
  });
  return (
    <Button
      variant="outline"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={copy.isPending}
      onClick={() => copy.mutate()}
    >
      <Copy />
    </Button>
  );
}

export function SettingsPage({
  visible,
  theme,
  onThemeChange,
  overview,
  providerTarget,
  updatesTarget,
  usageStatsTarget,
  desktopUpdates,
  onOpenPlugin,
  onOpenArchivedAgent,
  onOpenChat,
}: {
  visible: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  overview: UseQueryResult<
    Pick<Overview, "dataDir" | "agents" | "chats" | "permissionSettings">,
    Error
  >;
  providerTarget?: { id?: string; pluginId?: string };
  updatesTarget?: number;
  usageStatsTarget?: number;
  desktopUpdates?: DesktopUpdatesController;
  onOpenPlugin: (id?: string) => void;
  onOpenArchivedAgent?: (agent: Agent) => void;
  onOpenChat?: (chatId: string, agentId: string, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const providers = useProviders();
  const { preferences, updatePreferences } = usePreferences();
  const shortcuts = useComposerShortcuts();
  const keybindingGroups = shortcutGroups(preferences.shortcutOverrides);
  const [section, setSection] = useState<Section>(
    providerTarget
      ? "providers"
      : usageStatsTarget
        ? "usageStats"
        : updatesTarget && isMyGo()
          ? "updates"
          : "general",
  );
  const [providerId, setProviderId] = useState(providerTarget?.id);
  const [providerPlugin, setProviderPlugin] = useState(
    providerTarget?.pluginId,
  );
  const [sidebar, setSidebar] = useState(true);
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (providerTarget) {
      setSection("providers");
      setProviderId(providerTarget.id);
      setProviderPlugin(providerTarget.pluginId);
      setSearch("");
      if (innerWidth < 760) setSidebar(false);
    }
  }, [providerTarget]);
  useEffect(() => {
    if (updatesTarget && isMyGo()) {
      setSection("updates");
      setSearch("");
      if (innerWidth < 760) setSidebar(false);
    }
  }, [updatesTarget]);
  useEffect(() => {
    if (usageStatsTarget) {
      setSection("usageStats");
      setSearch("");
      if (innerWidth < 760) setSidebar(false);
    }
  }, [usageStatsTarget]);
  const language = useMutation({ mutationFn: changeLanguage });
  const preference = useMutation({
    mutationFn: async (patch: Parameters<typeof updatePreferences>[0]) =>
      updatePreferences(patch),
  });
  const openDirectory = useMutation({
    mutationFn: (path: string) => Dialogs.openDirectory(path),
  });
  const archivedAgents = (overview.data?.agents ?? []).filter(
    (agent) => agent.archived,
  );
  const restoreAgent = useMutation({
    mutationFn: async (agent: Agent) => {
      await api("/agents/" + agent.id, { ...agent, archived: false }, "PUT");
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const notificationSupport = useQuery({
    queryKey: ["desktop-notification-support"],
    queryFn: () => Notifications.supported(),
    enabled: visible && hasDesktopNotifications,
    staleTime: Infinity,
  });
  const taskRemindersQuery = useTaskReminderSettings(visible);
  const saveTaskReminders = useSaveTaskReminderSettings();
  const taskReminders = taskRemindersQuery.data ?? defaultReminderSettings;
  const taskDispatchQuery = useTaskDispatchSettings(visible);
  const saveTaskDispatch = useSaveTaskDispatchSettings();
  const taskDispatch = taskDispatchQuery.data ?? defaultTaskDispatchSettings;
  const delegationSettingsQuery = useDelegationSettings(visible);
  const saveDelegationSettings = useSaveDelegationSettings();
  const delegationSettings =
    delegationSettingsQuery.data ?? defaultDelegationSettings;
  const permissionSettingsQuery = usePermissionSettings(visible);
  const savePermissionSettings = useSavePermissionSettings();
  const permissionSettings =
    permissionSettingsQuery.data ??
    overview.data?.permissionSettings ??
    defaultPermissionSettings;
  const defaultReminderValue =
    taskReminders.defaultRemindOffsets.length > 0
      ? String(taskReminders.defaultRemindOffsets[0])
      : "-1";
  const query = search.trim().toLocaleLowerCase();
  const groups = sectionGroups
    .map((group) => ({
      ...group,
      sections: group.sections.filter((item) =>
        [
          t(`settings.group.${group.id}`),
          t(`settings.${item.id}`),
          ...item.fields.map((key) => t(`settings.${key}`)),
          ...(item.id === "shortcuts"
            ? keybindingGroups.flatMap(({ title, rows }) => [
                t(title),
                ...rows.flatMap(({ label, keys }) => [t(label), keys]),
              ])
            : []),
          ...(item.id === "archivedAgents"
            ? [
                t("profile.restore"),
                t("agents.noArchived"),
                ...archivedAgents.map((agent) => agent.name),
              ]
            : []),
        ].some((text) => text.toLocaleLowerCase().includes(query)),
      ),
    }))
    .filter((group) => group.sections.length > 0);

  function content(id: Section): ReactNode {
    switch (id) {
      case "providers":
        return (
          <Button
            className="self-start"
            variant="outline"
            onClick={() => {
              setSection("providers");
              setSearch("");
              if (innerWidth < 760) setSidebar(false);
            }}
          >
            {t("providers.openSettings")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        );
      case "general":
        return (
          <>
            <SettingsGroup title={t("settings.interface")}>
              <SettingsRow
                title={t("settings.theme")}
                description={t("settings.themeDescription")}
              >
                <ToggleGroup
                  id="settings-theme"
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={theme}
                  aria-label={t("settings.theme")}
                  onValueChange={(value) => {
                    if (
                      value === "system" ||
                      value === "light" ||
                      value === "dark"
                    )
                      onThemeChange(value);
                  }}
                >
                  <ToggleGroupItem value="system">
                    <Monitor data-icon="inline-start" />
                    {t("settings.system")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="light">
                    <Sun data-icon="inline-start" />
                    {t("settings.light")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="dark">
                    <Moon data-icon="inline-start" />
                    {t("settings.dark")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingsRow>
              <SettingsChoiceRow
                title={t("settings.language")}
                description={t("settings.languageDescription")}
                value={i18n.resolvedLanguage ?? "en-US"}
                onChange={(value) => language.mutate(value)}
                disabled={language.isPending}
                options={languages}
              />
            </SettingsGroup>
            {language.error && <ErrorNotice error={language.error} />}
            <SettingsGroup title={t("settings.conversation")}>
              <SettingsChoiceRow
                title={t("settings.sendShortcut")}
                description={t("settings.sendShortcutDescription", {
                  newline: shortcuts.newline,
                })}
                value={preferences.sendShortcut}
                onChange={(value) => {
                  const sendShortcut = sendShortcuts.find(
                    (option) => option === value,
                  );
                  if (sendShortcut) preference.mutate({ sendShortcut });
                }}
                options={sendShortcuts.map((value) => ({
                  value,
                  label:
                    value === "enter"
                      ? "Enter"
                      : `${isMac ? "⌘" : "Ctrl"} + Enter`,
                }))}
              />
              <SettingsChoiceRow
                title={t("settings.followUpBehavior")}
                description={t("settings.followUpBehaviorDescription", {
                  shortcut: shortcuts.alternate,
                })}
                value={preferences.followUpBehavior}
                onChange={(value) => {
                  const followUpBehavior = followUpBehaviors.find(
                    (option) => option === value,
                  );
                  if (followUpBehavior) preference.mutate({ followUpBehavior });
                }}
                options={followUpBehaviors.map((value) => ({
                  value,
                  label: t(
                    value === "queue" ? "queue.queueLabel" : "queue.steerLabel",
                  ),
                }))}
              />
              <SettingsChoiceRow
                title={t("settings.chatFontSize")}
                description={t("settings.chatFontSizeDescription")}
                value={String(preferences.chatFontSize)}
                onChange={(value) => {
                  const chatFontSize = chatFontSizes.find(
                    (size) => String(size) === value,
                  );
                  if (chatFontSize) preference.mutate({ chatFontSize });
                }}
                options={chatFontSizes.map((value) => ({
                  value: String(value),
                  label:
                    value === 14
                      ? t("settings.defaultFontSize", { size: value })
                      : `${value} px`,
                }))}
              />
              <SettingsChoiceRow
                title={t("settings.chatWidth")}
                description={t("settings.chatWidthDescription")}
                value={preferences.chatWidth}
                onChange={(value) => {
                  const chatWidth = chatWidths.find((width) => width === value);
                  if (chatWidth) preference.mutate({ chatWidth });
                }}
                options={chatWidths.map((value) => ({
                  value,
                  label: t(`settings.width.${value}`),
                }))}
              />
              <SettingsRow
                id="settings-show-context-usage"
                title={t("settings.showContextUsage")}
                description={t("settings.showContextUsageDescription")}
              >
                <Switch
                  id="settings-show-context-usage"
                  aria-describedby="settings-show-context-usage-description"
                  checked={preferences.showContextUsage}
                  onCheckedChange={(showContextUsage) =>
                    preference.mutate({ showContextUsage })
                  }
                />
              </SettingsRow>
            </SettingsGroup>
            <section
              className="settings-preview"
              aria-label={t("settings.preview")}
            >
              <span>{t("settings.preview")}</span>
              <p>{t("settings.previewText")}</p>
              <code>const agent = "Lever";</code>
            </section>
            <SettingsGroup title={t("settings.workbench")}>
              <SettingsChoiceRow
                title={t("settings.taskChatMode")}
                description={t("settings.taskChatModeDescription")}
                value={taskDispatch.chatMode}
                disabled={saveTaskDispatch.isPending}
                onChange={(value) => {
                  const chatMode = taskChatModes.find((mode) => mode === value);
                  if (chatMode && chatMode !== taskDispatch.chatMode) {
                    saveTaskDispatch.mutate(
                      { chatMode },
                      { onError: (error) => toast.error(error.message) },
                    );
                  }
                }}
                options={taskChatModes.map((value) => ({
                  value,
                  label: t(`settings.taskChatMode.${value}`),
                }))}
              />
              <SettingsRow
                id="settings-open-new-topic"
                title={t("settings.openNewTopicOnCreate")}
                description={t("settings.openNewTopicOnCreateDescription")}
              >
                <Switch
                  id="settings-open-new-topic"
                  aria-describedby="settings-open-new-topic-description"
                  checked={preferences.openNewTopicOnCreate}
                  onCheckedChange={(openNewTopicOnCreate) =>
                    preference.mutate({ openNewTopicOnCreate })
                  }
                />
              </SettingsRow>
              <SettingsChoiceRow
                title={t("settings.agentListLayout")}
                description={t("settings.agentListLayoutDescription")}
                value={preferences.agentSidebarLayout}
                onChange={(value) => {
                  const agentSidebarLayout = agentSidebarLayouts.find(
                    (layout) => layout === value,
                  );
                  if (agentSidebarLayout)
                    preference.mutate({ agentSidebarLayout });
                }}
                options={agentSidebarLayouts.map((value) => ({
                  value,
                  label: t(`settings.agentListLayout.${value}`),
                }))}
              />
              <SettingsRow
                title={t("settings.agentActivity")}
                description={t("settings.agentActivityDescription")}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={
                    preferences.expandAgentActivity ? "expanded" : "collapsed"
                  }
                  aria-label={t("settings.agentActivity")}
                  onValueChange={(value) => {
                    if (value)
                      preference.mutate({
                        expandAgentActivity: value === "expanded",
                      });
                  }}
                >
                  <ToggleGroupItem value="expanded">
                    {t("settings.expanded")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="collapsed">
                    {t("settings.collapsed")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingsRow>
              <WorkspaceTabLimitSetting
                value={preferences.maxWorkspaceTabs}
                onChange={(maxWorkspaceTabs) =>
                  preference.mutate({ maxWorkspaceTabs })
                }
              />
            </SettingsGroup>
            <SettingsGroup title={t("settings.notifications")}>
              {hasDesktopNotifications && (
                <SettingsRow
                  id="settings-desktop-notifications"
                  title={t("settings.desktopNotifications")}
                  description={t(
                    notificationSupport.data === false
                      ? "settings.desktopNotificationsPackaged"
                      : "settings.desktopNotificationsDescription",
                  )}
                >
                  <Switch
                    id="settings-desktop-notifications"
                    aria-describedby="settings-desktop-notifications-description"
                    checked={preferences.desktopNotifications}
                    disabled={notificationSupport.data !== true}
                    onCheckedChange={(desktopNotifications) =>
                      preference.mutate({ desktopNotifications })
                    }
                  />
                </SettingsRow>
              )}
              <SettingsRow
                title={t("settings.defaultTaskReminder")}
                description={t("settings.defaultTaskReminderDescription")}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={defaultReminderValue}
                  aria-label={t("settings.defaultTaskReminder")}
                  onValueChange={(value) => {
                    if (!value) return;
                    const minutes = Number(value);
                    saveTaskReminders.mutate(
                      {
                        ...taskReminders,
                        defaultRemindOffsets: minutes < 0 ? [] : [minutes],
                      },
                      { onError: (error) => toast.error(error.message) },
                    );
                  }}
                >
                  {defaultReminderChoiceOffsets.map((minutes) => (
                    <ToggleGroupItem
                      key={minutes}
                      value={String(minutes)}
                      disabled={saveTaskReminders.isPending}
                      className="tabular-nums"
                    >
                      {formatShortReminderOffset(minutes, t)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </SettingsRow>
              <SettingsRow
                title={t("settings.allDayReminderTime")}
                description={t("settings.allDayReminderTimeDescription")}
              >
                <AutomationTimePicker
                  value={taskReminders.allDayReminderTime}
                  disabled={saveTaskReminders.isPending}
                  onChange={(allDayReminderTime) =>
                    saveTaskReminders.mutate(
                      { ...taskReminders, allDayReminderTime },
                      { onError: (error) => toast.error(error.message) },
                    )
                  }
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title={t("settings.agentConfiguration")}>
              <SettingsRow
                title={t("settings.defaultDelegationPolicy")}
                description={t("settings.defaultDelegationPolicyDescription")}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={delegationSettings.defaultPolicy}
                  aria-label={t("settings.defaultDelegationPolicy")}
                  onValueChange={(value) => {
                    if (value !== "none" && value !== "all") return;
                    if (value === delegationSettings.defaultPolicy) return;
                    saveDelegationSettings.mutate(
                      { ...delegationSettings, defaultPolicy: value },
                      { onError: (error) => toast.error(error.message) },
                    );
                  }}
                >
                  <ToggleGroupItem
                    value="none"
                    disabled={saveDelegationSettings.isPending}
                  >
                    {t("settings.defaultDelegationPolicy.none")}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="all"
                    disabled={saveDelegationSettings.isPending}
                  >
                    {t("settings.defaultDelegationPolicy.all")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingsRow>
              <SettingsRow
                title={t("settings.nestedDelegation")}
                description={t("settings.nestedDelegationDescription")}
              >
                <ToggleGroup type="single" size="sm" aria-label={t("settings.nestedDelegation")} value={String(delegationSettings.maxDepth || 1)} disabled={saveDelegationSettings.isPending} onValueChange={v=>{if(v)saveDelegationSettings.mutate({...delegationSettings,maxDepth:Number(v)},{onError:error=>toast.error(error.message)})}}>
                  {[1,2,3].map(depth=><ToggleGroupItem key={depth} value={String(depth)}>{depth}</ToggleGroupItem>)}
                </ToggleGroup>
              </SettingsRow>
              <SettingsRow
                title={t("settings.agentDefaults")}
                description={t("settings.agentDefaultsDescription")}
              >
                <Badge variant="outline">{t("workspace.profile")}</Badge>
              </SettingsRow>
              <SettingsRow
                title={t("settings.permissions")}
                description={t("settings.permissionsDescription")}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={permissionSettings.defaultMode}
                  aria-label={t("settings.permissions")}
                  onValueChange={(value) => {
                    if (value !== "auto" && value !== "yolo") return;
                    if (value === permissionSettings.defaultMode) return;
                    savePermissionSettings.mutate(
                      { defaultMode: value },
                      { onError: (error) => toast.error(error.message) },
                    );
                  }}
                >
                  <ToggleGroupItem
                    value="auto"
                    disabled={savePermissionSettings.isPending}
                  >
                    {t("settings.defaultPermissionMode.auto")}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="yolo"
                    disabled={savePermissionSettings.isPending}
                  >
                    {t("settings.defaultPermissionMode.yolo")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingsRow>
            </SettingsGroup>
            <p className="settings-note">{t("settings.autoSave")}</p>
          </>
        );
      case "shortcuts":
        return (
          <>
            <ShortcutSettings groups={keybindingGroups} />
            <SettingsGroup title={t("settings.conversation")}>
              <SettingsRow title={t("settings.sendMessage")}>
                <kbd>{shortcuts.send}</kbd>
              </SettingsRow>
              {followUpBehaviors.map((behavior) => (
                <SettingsRow
                  key={behavior}
                  title={t(`settings.${behavior}Message`)}
                  description={t(`settings.${behavior}Description`)}
                >
                  <kbd>
                    {behavior === shortcuts.followUp.primary
                      ? shortcuts.send
                      : shortcuts.alternate}
                  </kbd>
                </SettingsRow>
              ))}
              <SettingsRow title={t("settings.newLine")}>
                <kbd>{shortcuts.newline}</kbd>
              </SettingsRow>
              <SettingsRow
                title={t("settings.suggestions")}
                description={t("settings.suggestionsDescription")}
              >
                <kbd>@</kbd>
                <kbd>/</kbd>
              </SettingsRow>
              <SettingsRow title={t("settings.chooseSuggestion")}>
                <kbd>↑ / ↓</kbd>
                <kbd>Enter / Tab</kbd>
              </SettingsRow>
            </SettingsGroup>
          </>
        );
      case "remoteDevices":
        return (
          <RemoteDevices
            title={t("settings.remoteDevices")}
            titleId="settings-section-remoteDevices"
            agents={overview.data?.agents ?? []}
            chats={overview.data?.chats ?? []}
          />
        );
      case "usageStats":
        return (
          <UsageStatsPage
            visible={visible && (!!query || section === "usageStats")}
            providers={providers.data ?? []}
            onOpenChat={onOpenChat}
          />
        );
      case "updates":
        return desktopUpdates ? (
          <UpdatesSettings controller={desktopUpdates} />
        ) : null;
      case "storage":
        return (
          <>
            {overview.isPending && <Loading />}
            {overview.error && (
              <ErrorNotice
                error={overview.error}
                retry={() => void overview.refetch()}
              />
            )}
            {overview.data && (
              <SettingsGroup title={t("settings.workspaceData")}>
                <SettingsRow
                  title={t("settings.dataDir")}
                  description={t("settings.dataDirDescription")}
                >
                  <div className="settings-directory">
                    <code className="settings-path">
                      {overview.data.dataDir}
                    </code>
                    <div className="settings-inline-actions">
                      <CopyButton
                        value={overview.data.dataDir}
                        label={t("settings.copyPath")}
                      />
                      {isMyGo() && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={openDirectory.isPending}
                          onClick={() =>
                            openDirectory.mutate(overview.data!.dataDir)
                          }
                        >
                          <FolderOpen data-icon="inline-start" />
                          {t("settings.openDirectory")}
                        </Button>
                      )}
                    </div>
                  </div>
                </SettingsRow>
                <NotesDirectorySetting />
              </SettingsGroup>
            )}
            {openDirectory.error && <ErrorNotice error={openDirectory.error} />}
            <SettingsGroup title={t("settings.localPreferences")}>
              <SettingsRow
                title={t("settings.devicePreferences")}
                description={t("settings.localPreferencesDescription")}
              >
                <Badge variant="outline">{t("settings.thisDevice")}</Badge>
              </SettingsRow>
            </SettingsGroup>
          </>
        );
      case "archivedAgents":
        return (
          <>
            {overview.isPending && <Loading />}
            {overview.error && (
              <ErrorNotice
                error={overview.error}
                retry={() => void overview.refetch()}
              />
            )}
            <p className="settings-note">
              {t("settings.archivedAgentsDescription")}
            </p>
            {overview.data &&
              (archivedAgents.length === 0 ? (
                <Empty className="panel-surface py-10">
                  <EmptyHeader>
                    <EmptyTitle>{t("agents.noArchived")}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <FieldGroup className="settings-group panel-surface">
                  {archivedAgents.map((agent) => {
                    const providerName =
                      providers.data?.find(
                        (provider) => provider.id === agent.profile.provider,
                      )?.name ?? agent.profile.provider;
                    const chatCount = (overview.data?.chats ?? []).filter(
                      (chat) => chat.agentId === agent.id,
                    ).length;
                    const description = [
                      providerName,
                      chatCount > 0
                        ? t("settings.archivedAgentsChatCount", {
                            count: chatCount,
                          })
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <SettingsRow
                        key={agent.id}
                        title={
                          <span className="flex min-w-0 items-center gap-2.5">
                            <AgentAvatar agent={agent} size="sm" />
                            <span className="truncate">{agent.name}</span>
                          </span>
                        }
                        description={description}
                      >
                        <div className="settings-inline-actions">
                          {chatCount > 0 && onOpenArchivedAgent && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onOpenArchivedAgent(agent)}
                            >
                              {t("agents.openHistoryChat")}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              restoreAgent.isPending &&
                              restoreAgent.variables?.id === agent.id
                            }
                            onClick={() => restoreAgent.mutate(agent)}
                          >
                            <RotateCcw data-icon="inline-start" />
                            {t("profile.restore")}
                          </Button>
                        </div>
                      </SettingsRow>
                    );
                  })}
                </FieldGroup>
              ))}
          </>
        );
    }
  }

  return (
    <main
      className="workspace-frame settings-page"
      hidden={!visible}
      inert={!visible}
      aria-label={t("nav.settings")}
    >
      <SecondarySidebar
        id="settings-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <div className="sidebar-heading">
          <h1>{t("nav.settings")}</h1>
        </div>
        <div className="settings-search">
          <InputGroup className="sidebar-search-control">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("settings.search")}
              aria-label={t("settings.search")}
            />
            {search && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={t("settings.clearSearch")}
                  onClick={() => setSearch("")}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        <nav
          className="settings-navigation"
          aria-label={t("settings.categories")}
        >
          {groups.map((group) => (
            <section
              key={group.id}
              className="settings-navigation-group"
              aria-labelledby={`settings-group-${group.id}`}
            >
              <h2 id={`settings-group-${group.id}`}>
                {t(`settings.group.${group.id}`)}
              </h2>
              {group.sections.map(({ id, icon: Icon }) => (
                <Button
                  key={id}
                  variant="ghost"
                  className="sidebar-nav-item"
                  aria-current={!query && section === id ? "page" : undefined}
                  onClick={() => {
                    setSection(id);
                    setSearch("");
                    if (innerWidth < 760) setSidebar(false);
                  }}
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{t(`settings.${id}`)}</span>
                  {id === "updates" && desktopUpdates?.hasActionableUpdate && (
                    <span
                      className="ms-auto size-2 shrink-0 rounded-full bg-[var(--status-attention)]"
                      aria-label={t("settings.updatesAvailableDot")}
                    />
                  )}
                  {id === "archivedAgents" && archivedAgents.length > 0 && (
                    <span className="ms-auto text-xs tabular-nums text-muted-foreground">
                      {archivedAgents.length}
                    </span>
                  )}
                </Button>
              ))}
            </section>
          ))}
        </nav>
      </SecondarySidebar>
      {!query && section === "providers" ? (
        <SettingsProviders
          visible={visible}
          target={providerTarget}
          providerId={providerId}
          pluginId={providerPlugin}
          onSelect={setProviderId}
          onShowAll={() => setProviderPlugin(undefined)}
          onOpenPlugin={onOpenPlugin}
        />
      ) : (
        <div className="settings-scroll" key={query ? "search" : section}>
          <div className="settings-content">
            {query && (
              <p className="settings-search-summary" role="status">
                {t("settings.searchResults", {
                  count: groups.reduce(
                    (count, group) => count + group.sections.length,
                    0,
                  ),
                })}
              </p>
            )}
            {groups.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t("settings.noMatches")}</EmptyTitle>
                  <EmptyDescription>{t("settings.trySearch")}</EmptyDescription>
                </EmptyHeader>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearch("")}
                >
                  {t("settings.clearSearch")}
                </Button>
              </Empty>
            ) : (
              (query
                ? groups.flatMap((group) =>
                    group.sections.map((item) => item.id),
                  )
                : [section]
              ).map((id) => (
                <section
                  key={id}
                  className="settings-category"
                  aria-labelledby={`settings-section-${id}`}
                >
                  {id !== "remoteDevices" && id !== "usageStats" && (
                    <h2 id={`settings-section-${id}`}>{t(`settings.${id}`)}</h2>
                  )}
                  {content(id)}
                </section>
              ))
            )}
            {preference.error && <ErrorNotice error={preference.error} />}
          </div>
        </div>
      )}
    </main>
  );
}
