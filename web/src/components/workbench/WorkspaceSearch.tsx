import { displayChatTitle } from "@/features/chat/conversationTitle";
import type { WorkbenchOverview } from "@/components/workbench/workbenchOverview";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  Check,
  ChevronDown,
  FileCode,
  Folder,
  GitBranch,
  MessageCircle,
  Search,
  TextSearch,
  UsersRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  Conversation,
  MessageMatch,
  MessageMatchPart,
  Root,
} from "@/api/types.gen";
import { api } from "@/api/client";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchHighlight } from "@/components/ui/search-highlight";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { sessionQuery } from "@/features/chat/queries";
import { RunStatus } from "@/features/chat/RunStatus";
import { rootName } from "@/features/files/filePaths";
import {
  fileSearchQuery,
  type AgentFileSource,
} from "@/features/files/fileSource";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";

type ScopeOption = { value: string; label: string };
export type SearchScope = `agent:${string}` | `chat:${string}`;
const resultTypes = [
  "all",
  "agent",
  "chat",
  "topic",
  "message",
  "unread",
  "file",
] as const;
export type SearchType = (typeof resultTypes)[number];
const messageKinds = ["main", "comparison", "topic"] as const;
const optionStyle =
  "cursor-default rounded-md outline-none aria-selected:bg-accent aria-selected:text-accent-foreground";

function ScopePicker({
  value,
  all,
  agents,
  chats,
  onChange,
}: {
  value: string;
  all: ScopeOption;
  agents: ScopeOption[];
  chats: ScopeOption[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groups = [
    { options: [all] },
    { label: t("conversationSearch.agents"), options: agents },
    { label: t("conversationSearch.chats"), options: chats },
  ];
  const selected = [...agents, ...chats].find(
    (option) => option.value === value,
  );
  const label = selected?.label ?? all.label;
  const scopeLabel = t("conversationSearch.scope");
  const queryLabel = t("conversationSearch.scopeQuery");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={scopeLabel}
          aria-description={label}
          title={label}
          className="max-w-full min-w-0 justify-between"
        >
          <span className="truncate">{label}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={scopeLabel}
        className="w-72 max-w-[calc(100vw-24px)] p-2"
      >
        <Command label={queryLabel} defaultValue={value}>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <Command.Input asChild>
              <InputGroupInput
                aria-label={queryLabel}
                placeholder={queryLabel}
              />
            </Command.Input>
          </InputGroup>
          <Command.List className="mt-1 max-h-60 overflow-auto">
            <Command.Empty className="px-2 py-3 text-sm text-muted-foreground">
              {t("conversationSearch.empty")}
            </Command.Empty>
            {groups.map(
              ({ label, options }) =>
                options.length > 0 && (
                  <Command.Group
                    key={label ?? all.value}
                    heading={label}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {options.map((option) => (
                      <Command.Item
                        key={option.value}
                        value={option.value}
                        keywords={[option.label]}
                        className={
                          optionStyle +
                          " flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
                        }
                        onSelect={() => {
                          onChange(option.value);
                          setOpen(false);
                        }}
                      >
                        <span className="truncate">{option.label}</span>
                        {value === option.value && (
                          <Check className="size-4 shrink-0" />
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ),
            )}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function FileScopePicker({
  roots,
  selected,
  onChange,
}: {
  roots: Root[];
  selected: Root | undefined;
  onChange: (rootId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const root = roots[0];
  if (!root) return null;
  if (roots.length === 1)
    return (
      <span
        className="ml-auto flex min-w-0 items-center gap-1.5 px-2 text-sm text-muted-foreground"
        title={root.path}
      >
        <Folder className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{rootName(root)}</span>
      </span>
    );
  return (
    <Select
      value={selected ? `root:${selected.id}` : "all"}
      onValueChange={(value) =>
        onChange(value === "all" ? undefined : value.slice(5))
      }
    >
      <SelectTrigger
        aria-label={t("files.scopeRoot")}
        title={selected?.path}
        size="sm"
        className="ml-auto max-w-full min-w-0"
      >
        <Folder aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        <SelectItem value="all">
          {t("conversationSearch.allDirectories")}
        </SelectItem>
        {roots.map((root) => (
          <SelectItem key={root.id} value={`root:${root.id}`} title={root.path}>
            {rootName(root)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type SearchEntry = {
  id: string;
  title: string;
  path?: string;
  preview?: string | MessageMatchPart[];
  activity?: Conversation;
  open: () => void;
};

function MessageSearchPreview({ parts }: { parts: MessageMatchPart[] }) {
  return parts.map(({ text, tags, highlight }, index) => {
    const content =
      tags?.reduceRight<ReactNode>((child, tag) => {
        switch (tag) {
          case "strong":
            return <strong className="font-semibold">{child}</strong>;
          case "em":
            return <em>{child}</em>;
          case "del":
            return <del>{child}</del>;
          case "code":
            return <code className="font-mono">{child}</code>;
          case "a":
            return (
              <span className="underline decoration-muted-foreground/50 underline-offset-2">
                {child}
              </span>
            );
          default:
            return child;
        }
      }, text) ?? text;
    return highlight ? (
      <mark key={index}>{content}</mark>
    ) : (
      <Fragment key={index}>{content}</Fragment>
    );
  });
}

const icons = {
  agent: UsersRound,
  chat: MessageCircle,
  topic: GitBranch,
  message: TextSearch,
  file: FileCode,
};

export function WorkspaceSearch({
  initialScope = "all",
  initialType,
  fileSource,
  overview,
  readCursors,
  returnFocus,
  onClose,
  onSelect,
  onAgent,
  onFile,
}: {
  initialScope?: SearchScope | "all";
  initialType: SearchType;
  fileSource?: AgentFileSource;
  overview: WorkbenchOverview;
  readCursors: Record<string, number>;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onSelect: (chatId: string, topicId?: string, runId?: string) => void;
  onAgent: (agentId: string) => void;
  onFile: (root: Root, path: string, source: AgentFileSource) => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<string>(initialScope);
  const [type, setType] = useState<string>(initialType);
  const [messageKind, setMessageKind] = useState("");
  const [rootId, setRootId] = useState<string>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [debounced, setDebounced] = useState("");
  const opened = useRef(false);
  const term = query.trim();
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term), 180);
    return () => window.clearTimeout(timer);
  }, [term]);
  const searchMessages = !!term && (type === "all" || type === "message");
  const kind = type === "message" ? messageKind : "";
  const messages = useQuery({
    queryKey: ["message-search", scope, kind, debounced],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ query: debounced });
      if (scope.startsWith("agent:")) params.set("agentId", scope.slice(6));
      if (scope.startsWith("chat:")) params.set("chatId", scope.slice(5));
      if (kind) params.set("kind", kind);
      return api<MessageMatch[]>(
        `/search/messages?${params}`,
        undefined,
        "GET",
        signal,
      );
    },
    enabled: searchMessages && term === debounced,
    staleTime: 0,
    retry: false,
  });
  const matches =
    searchMessages && term === debounced ? messages.data : undefined;
  const showFiles =
    !!fileSource && (type === "file" || (type === "all" && scope === "all"));
  const session = useQuery({
    ...sessionQuery(fileSource?.sessionId ?? ""),
    enabled: showFiles && !!fileSource?.sessionId,
  });
  const workingCopyId = fileSource?.sessionId
    ? undefined
    : fileSource?.workingCopyId;
  const copies = useWorkingCopies(
    fileSource?.id ?? "",
    showFiles && !!workingCopyId,
  );
  const scopeQuery = workingCopyId ? copies : session;
  const fileScope = fileSource?.sessionId
    ? session.data?.session
    : workingCopyId
      ? copies.data?.find(
          (copy) => copy.id === workingCopyId && availableGroup(copy),
        )
      : overview.agents.find((agent) => agent.id === fileSource?.id)?.profile;
  const roots = fileScope?.roots ?? [];
  const root = roots.find((item) => item.id === rootId);
  const searchFiles = showFiles && !!term && roots.length > 0;
  const files = useQuery({
    ...fileSearchQuery(
      searchFiles ? fileSource : undefined,
      fileScope?.roots,
      "path",
      debounced,
      root?.id,
    ),
    enabled: searchFiles && term === debounced,
    retry: false,
  });
  const fileResults =
    searchFiles && term === debounced ? files.data : undefined;
  const scopeError = showFiles && !fileScope ? scopeQuery.error : null;
  const fileError = searchFiles && term === debounced ? files.error : null;
  const loading =
    (searchMessages && (term !== debounced || messages.isFetching)) ||
    (showFiles &&
      !!(fileSource?.sessionId || workingCopyId) &&
      scopeQuery.isPending) ||
    (searchFiles && (term !== debounced || files.isFetching));

  const agents = new Map(overview.agents.map((agent) => [agent.id, agent]));
  const chats = new Map(overview.chats.map((chat) => [chat.id, chat]));
  const main = new Map<string, Conversation>();
  const topics = new Map<string, Conversation>();
  for (const conversation of overview.conversations) {
    if (conversation.kind === "main")
      main.set(conversation.chatId, conversation);
    if (conversation.kind === "topic")
      topics.set(conversation.id, conversation);
  }
  const statuses = new Map<string, string>();
  for (const run of overview.runs) {
    if (run.status !== "queued" || !statuses.has(run.sessionId))
      statuses.set(run.sessionId, run.status);
    if (
      run.operation === "topic" &&
      run.status === "queued" &&
      !topics.get(run.sessionId)?.messageAt
    ) {
      topics.set(run.sessionId, {
        id: run.sessionId,
        agentId: run.agentId,
        chatId: run.chatId,
        kind: "topic",
        title: run.title,
        messageAt: run.createdAt,
        preview: "",
        unreadSequence: 0,
      });
    }
  }
  for (const request of overview.requests)
    statuses.set(request.sessionId, "waiting_user");

  const needle = term.toLocaleLowerCase();
  const matchesTitle = (value: string) =>
    value.toLocaleLowerCase().includes(needle);
  const isUnread = (activity?: Conversation) =>
    !!activity && activity.unreadSequence > (readCursors[activity.id] ?? 0);
  const matchesConversation = (
    title: string,
    chatId: string,
    activity?: Conversation,
  ) => {
    if (type !== "unread") return matchesTitle(title);
    const chat = chats.get(chatId);
    return (
      isUnread(activity) &&
      [
        title,
        activity?.preview,
        chat?.title,
        chat && agents.get(chat.agentId)?.name,
      ].some((value) => value && matchesTitle(value))
    );
  };
  const inScope = (chatId: string, agentId: string) =>
    scope === "all" ||
    scope === `agent:${agentId}` ||
    scope === `chat:${chatId}`;
  const agentEntries = overview.agents
    .filter(
      (agent) =>
        (scope === "all" || scope === `agent:${agent.id}`) &&
        matchesTitle(agent.name),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(
      (agent): SearchEntry => ({
        id: `agent:${agent.id}`,
        title: agent.name,
        path: agent.archived ? t("common.archived") : undefined,
        open: () => onAgent(agent.id),
      }),
    );
  const chatEntries = overview.chats
    .filter(
      (chat) =>
        inScope(chat.id, chat.agentId) &&
        matchesConversation(
          displayChatTitle(chat, t),
          chat.id,
          main.get(chat.id),
        ),
    )
    .sort(
      (a, b) =>
        Math.max(
          Date.parse(b.updatedAt),
          Date.parse(main.get(b.id)?.messageAt ?? "") || 0,
        ) -
        Math.max(
          Date.parse(a.updatedAt),
          Date.parse(main.get(a.id)?.messageAt ?? "") || 0,
        ),
    )
    .map(
      (chat): SearchEntry => ({
        id: `chat:${chat.id}`,
        title: displayChatTitle(chat, t),
        path: agents.get(chat.agentId)?.name,
        preview: type === "unread" ? main.get(chat.id)?.preview : undefined,
        activity: main.get(chat.id),
        open: () => onSelect(chat.id),
      }),
    );
  const topicEntries = Array.from(topics.values())
    .filter(
      (topic) =>
        inScope(topic.chatId, topic.agentId) &&
        matchesConversation(
          topic.title || t("chat.topic"),
          topic.chatId,
          topic,
        ),
    )
    .sort(
      (a, b) => (Date.parse(b.messageAt) || 0) - (Date.parse(a.messageAt) || 0),
    )
    .flatMap((topic): SearchEntry[] => {
      const chat = chats.get(topic.chatId);
      if (!chat) return [];
      return [
        {
          id: `topic:${topic.id}`,
          title: topic.title || t("chat.topic"),
          path:
            scope === `chat:${chat.id}`
              ? undefined
              : `${agents.get(chat.agentId)?.name} › ${displayChatTitle(chat, t)}`,
          preview:
            (scope === `chat:${chat.id}` || type === "unread") &&
            topic.preview !== topic.title
              ? topic.preview
              : undefined,
          activity: topic,
          open: () => onSelect(chat.id, topic.id),
        },
      ];
    });
  const messageEntries = (matches ?? []).flatMap((match): SearchEntry[] => {
    const chat = chats.get(match.chatId);
    if (!chat) return [];
    return [
      {
        id: `message:${match.runId}`,
        title: match.topicId
          ? topics.get(match.topicId)?.title || t("chat.topic")
          : displayChatTitle(chat, t),
        path: match.topicId
          ? `${agents.get(chat.agentId)?.name} › ${displayChatTitle(chat, t)}`
          : agents.get(chat.agentId)?.name,
        preview: match.preview ?? match.text,
        open: () => onSelect(chat.id, match.topicId, match.runId),
      },
    ];
  });
  const fileEntries = fileSource
    ? (fileResults?.matches ?? []).flatMap((match): SearchEntry[] => {
        const root = roots.find((item) => item.id === match.rootId);
        if (!root) return [];
        const slash = match.path.lastIndexOf("/");
        return [
          {
            id: `file:${JSON.stringify([root.id, match.path])}`,
            title: match.path.slice(slash + 1),
            path:
              slash < 0
                ? rootName(root)
                : `${rootName(root)} / ${match.path.slice(0, slash)}`,
            open: () => onFile(root, match.path, fileSource),
          },
        ];
      })
    : [];
  const groups = [
    { kind: "topic", entries: topicEntries },
    { kind: "chat", entries: chatEntries },
    { kind: "agent", entries: agentEntries },
    { kind: "file", entries: fileEntries },
    { kind: "message", entries: messageEntries },
  ] as const;
  const showRecent = type === "all" && scope === "all" && !term;
  const visibleGroups = groups.flatMap(({ kind, entries }) => {
    const visible =
      type === "all" ||
      type === kind ||
      (type === "unread" && (kind === "chat" || kind === "topic"));
    if (!visible || !entries.length) return [];
    return [{ kind, rows: showRecent ? entries.slice(0, 5) : entries }];
  });
  const activeResult = visibleGroups.some(({ rows }) =>
    rows.some(({ id }) => id === selected),
  )
    ? selected
    : (visibleGroups[0]?.rows[0]?.id ?? "");
  const messageError =
    searchMessages && term === debounced ? messages.error : null;
  const searchLabel = t("conversationSearch.title");
  const placeholder =
    {
      file: t("conversationSearch.searchFiles"),
      chat: t("conversationSearch.searchChats"),
      topic: t("conversationSearch.searchTopics"),
    }[type] ?? searchLabel;
  const emptyLabel = loading
    ? "common.loading"
    : type === "file" && !roots.length
      ? "conversationSearch.noDirectories"
      : type === "file" && !term
        ? "conversationSearch.enterFileQuery"
        : type === "message" && !term
          ? "conversationSearch.enterQuery"
          : "conversationSearch.empty";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="top-[min(14dvh,8rem)] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[42rem]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!opened.current) returnFocus?.focus();
        }}
      >
        <DialogTitle className="sr-only">
          {t("conversationSearch.title")}
        </DialogTitle>
        <Command
          label={searchLabel}
          shouldFilter={false}
          value={activeResult}
          onValueChange={setSelected}
          loop
          className="min-w-0"
        >
          <div className="flex items-center gap-3 border-b px-4 pr-12">
            <Search
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <Command.Input
              className="h-13 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              placeholder={placeholder}
              value={query}
              maxLength={256}
              onValueChange={(value) => {
                setQuery(value);
                setSelected("");
              }}
            />
          </div>
          <Command.List className="min-h-30 max-h-[min(26rem,55dvh)] overflow-auto px-2 py-1.5">
            {!visibleGroups.length &&
              !messageError &&
              !scopeError &&
              !fileError && (
                <Empty className="py-7" aria-live="polite">
                  <EmptyHeader>
                    <EmptyTitle>{t(emptyLabel)}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            {visibleGroups.map(({ kind, rows }) => {
              const Icon = icons[kind];
              return (
                <Command.Group
                  key={kind}
                  heading={t(`conversationSearch.group.${kind}`)}
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {rows.map(({ id, title, path, preview, activity, open }) => {
                    const status = activity && statuses.get(activity.id);
                    const unread = isUnread(activity);
                    return (
                      <Command.Item
                        key={id}
                        value={id}
                        className={
                          optionStyle +
                          " flex min-w-0 items-start gap-2.5 px-2.5 py-2 [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-foreground"
                        }
                        onSelect={() => {
                          opened.current = true;
                          onClose();
                          open();
                        }}
                      >
                        <Icon
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate">
                              <SearchHighlight text={title} query={term} />
                            </span>
                            {unread && (
                              <span
                                role="img"
                                aria-label={t("agents.unread")}
                                className="agent-unread shrink-0"
                              />
                            )}
                            {status && <RunStatus status={status} />}
                            {path && (
                              <span
                                className="ml-auto max-w-[40%] truncate text-xs text-muted-foreground"
                                title={path}
                              >
                                {path}
                              </span>
                            )}
                          </div>
                          {preview && (
                            <div className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
                              {typeof preview === "string" ? (
                                <SearchHighlight text={preview} query={term} />
                              ) : (
                                <MessageSearchPreview parts={preview} />
                              )}
                            </div>
                          )}
                        </div>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              );
            })}
            {messageError && (
              <ErrorNotice
                error={messageError}
                retry={() => void messages.refetch()}
              />
            )}
            {(scopeError || fileError) && (
              <ErrorNotice
                error={scopeError || fileError}
                retry={() =>
                  void (scopeError ? scopeQuery.refetch() : files.refetch())
                }
              />
            )}
            {fileResults?.truncated && (
              <p
                className="px-2.5 py-2 text-xs text-muted-foreground"
                role="status"
              >
                {t("files.resultsLimited")}
              </p>
            )}
          </Command.List>
          <div
            className="flex flex-col gap-2 border-t px-2.5 py-2"
            onKeyDown={(event) => event.stopPropagation()}
          >
            {type === "message" && (
              <ToggleGroup
                type="single"
                value={messageKind}
                onValueChange={setMessageKind}
                size="sm"
                spacing={1}
                className="flex-wrap"
                aria-label={t("conversationSearch.messageKind")}
              >
                {messageKinds.map((item) => (
                  <ToggleGroupItem
                    key={item}
                    value={item}
                    className="rounded-full text-muted-foreground data-[state=on]:text-foreground"
                  >
                    {t(`conversationSearch.messageKind.${item}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ToggleGroup
                type="single"
                value={type}
                onValueChange={(value) => value && setType(value)}
                size="sm"
                spacing={1}
                className="flex-wrap"
                aria-label={t("conversationSearch.type")}
              >
                {resultTypes
                  .filter((item) => item !== "file" || fileSource)
                  .map((item) => (
                    <ToggleGroupItem
                      key={item}
                      value={item}
                      className="rounded-full text-muted-foreground data-[state=on]:text-foreground"
                    >
                      {t(`conversationSearch.type.${item}`)}
                    </ToggleGroupItem>
                  ))}
              </ToggleGroup>
              {type === "file" ? (
                <FileScopePicker
                  roots={roots}
                  selected={root}
                  onChange={setRootId}
                />
              ) : (
                <ScopePicker
                  value={scope}
                  all={{
                    value: "all",
                    label: t("conversationSearch.allScopes"),
                  }}
                  agents={overview.agents.map((agent) => ({
                    value: `agent:${agent.id}`,
                    label: agent.name,
                  }))}
                  chats={overview.chats.map((chat) => ({
                    value: `chat:${chat.id}`,
                    label: `${agents.get(chat.agentId)?.name} › ${displayChatTitle(chat, t)}`,
                  }))}
                  onChange={setScope}
                />
              )}
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
