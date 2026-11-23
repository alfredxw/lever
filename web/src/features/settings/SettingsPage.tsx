import { useEffect, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import {
  ArrowRight,
  Copy,
  FolderOpen,
  HardDrive,
  Keyboard,
  Monitor,
  Moon,
  Plug,
  Search,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Overview } from "@/api/types.gen";
import { Dialogs, Notifications } from "@/api/desktop.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FieldError } from "@/components/ui/field";
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
import { hasDesktopNotifications } from "@/features/agents/desktopNotifications";
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
import { RemoteDevices } from "./RemoteDevices";
import { NotesDirectorySetting } from "./NotesDirectorySetting";
import { SettingsProviders } from "./SettingsProviders";

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
          "workbench",
          "taskChatMode",
          "taskChatModeDescription",
          "taskChatMode.single",
          "taskChatMode.bySource",
          "taskChatMode.newChat",
          "openNewTopicOnCreate",
          "openNewTopicOnCreateDescription",
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
          "permissions",
          "permissionsDescription",
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
        id: "storage",
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
  onOpenPlugin,
}: {
  visible: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  overview: UseQueryResult<Pick<Overview, "dataDir" | "agents" | "chats">, Error>;
  providerTarget?: { id?: string; pluginId?: string };
  onOpenPlugin: (id?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { preferences, updatePreferences } = usePreferences();
  const shortcuts = useComposerShortcuts();
  const keybindingGroups = shortcutGroups(preferences.shortcutOverrides);
  const [section, setSection] = useState<Section>(
    providerTarget ? "providers" : "general",
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
  const language = useMutation({ mutationFn: changeLanguage });
  const preference = useMutation({
    mutationFn: async (patch: Parameters<typeof updatePreferences>[0]) =>
      updatePreferences(patch),
  });
  const openDirectory = useMutation({
    mutationFn: (path: string) => Dialogs.openDirectory(path),
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
                title={t("settings.agentDefaults")}
                description={t("settings.agentDefaultsDescription")}
              >
                <Badge variant="outline">{t("workspace.profile")}</Badge>
              </SettingsRow>
              <SettingsRow
                title={t("settings.permissions")}
                description={t("settings.permissionsDescription")}
              >
                <Badge variant="outline">{t("settings.perAgent")}</Badge>
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
      case "remoteDevices": return <RemoteDevices agents={overview.data?.agents??[]} chats={overview.data?.chats??[]}/>;
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
                  {t(`settings.${id}`)}
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
                  <h2 id={`settings-section-${id}`}>{t(`settings.${id}`)}</h2>
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
