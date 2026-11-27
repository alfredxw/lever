import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  CornerUpLeft,
  Maximize2,
  MessageCircle,
  Pin,
  UserRound,
} from "lucide-react";
import { active, api } from "@/api/client";
import type {
  Agent,
  Overview,
  Run,
  Session,
  SessionView,
  TopicSource,
  MessageQuote,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  type MessagePositions,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageTimeline,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { useGitRoots } from "@/features/diff/useGitRoots";
import { cn } from "@/lib/utils";
import { Composer } from "./Composer";
import type { OpenChatFile } from "./ChatResponse";
import { ComposerContext } from "./ComposerContext";
import { displayChatTitle } from "./conversationTitle";
import {
  ImagePreview,
  ImagePreviewProvider,
  useImagePreview,
} from "./ImagePreview";
import type { MessageActionHandlers } from "./MessageActions";
import { Item, ItemContent, ItemGroup, ItemMedia } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { UserMessage } from "./UserMessage";
import { canRecoverRun, RunRecoveryButton } from "./RunRecoveryButton";
import { canContinueRun } from "./runControls";
import { canEditSentMessage, RunContent } from "./RunContent";
import { isWorking, RunStatus } from "./RunStatus";
import { useRevealEntry } from "./useRevealEntry";
import { useUnreadStart } from "./useUnreadStart";
import type { OpenRun } from "./DelegatedTasks";
import {
  ActiveDelegationsBar,
  isDelegatedRunActive,
  selectSessionDelegations,
} from "./ActiveDelegationsBar";
import { useFocusComposer } from "./useFocusComposer";
import { TopicSourceContent } from "./TopicSourceContent";
import { WaitingDependencies } from "./WaitingDependencies";
import { formatChannelOrigin } from "./conversationTitle";
import {
  chatDelegationsQuery,
  prefetchTopicHistory,
  sessionQuery,
  topicPreviewQuery,
  sessionRunsQuery,
  useChatActivity,
} from "./queries";

type TopicProps = {
  session: Session;
  root: Run;
  agent: Agent;
  activeRuns: Run[];
  replyCount: number;
  enabled: boolean;
};

function mergeTopicRuns(
  sessionId: string,
  root: Run | undefined,
  history: Run[],
  activeRuns: Run[],
) {
  // A replacement can reach the runs query before the root metadata refreshes.
  const runs = new Map<number, Run>(
    root && !root.superseded ? [[root.sequence, root]] : [],
  );
  for (const run of history) runs.set(run.sequence, run);
  for (const run of activeRuns) {
    if (
      run.sessionId === sessionId &&
      (active(run.status) ||
        run.status === "paused" ||
        (run.status === "queued" && run.id === root?.id))
    )
      runs.set(run.sequence, run);
  }
  return [...runs.values()].sort((a, b) => a.sequence - b.sequence);
}

export function topicTitle(session: Session, root?: Run) {
  return (
    session.title ||
    root?.input ||
    root?.quote?.text ||
    root?.attachments[0]?.name ||
    root?.references?.[0]?.name
  );
}

export function Topic({
  selected,
  pinned,
  onPinnedChange,
  onExpand,
  onOpen,
  onQuote,
  onForward,
  onEdit,
  onOpenRun,
  ...props
}: TopicProps &
  MessageActionHandlers & {
    selected: boolean;
    pinned: boolean;
    onPinnedChange: (pinned: boolean) => void;
    onExpand?: () => void;
    onOpen: () => void;
    onEdit: (run: Run) => void;
    onOpenRun?: OpenRun;
  }) {
  const { t } = useTranslation();
  const { session, root, agent, activeRuns } = props;
  const query = useQuery({
    ...topicPreviewQuery(session.id),
    subscribed: props.enabled,
    enabled:
      props.enabled &&
      (props.replyCount > 0 ||
        activeRuns.some(
          (run) =>
            run.sessionId === session.id &&
            run.id !== root.id &&
            active(run.status),
        )),
  });
  const runs = useMemo(
    () => mergeTopicRuns(session.id, root, query.data?.runs ?? [], activeRuns),
    [session.id, root, query.data?.runs, activeRuns],
  );
  const prefetchReplies = () => prefetchTopicHistory(session.id);
  const latest = runs.at(-1) ?? root;
  const preview = runs
    .flatMap((run) => {
      const output: { id: string; user: boolean; text: string }[] = [];
      for (const item of run.items) {
        if (item.kind === "user" && item.message) {
          output.push({
            id: `${run.id}:${item.id}`,
            user: true,
            text:
              item.message.input ||
              item.message.quote?.text ||
              item.message.attachments.map((file) => file.name).join(", "),
          });
        } else if (item.kind === "text" && item.text.trim()) {
          const previous = output.at(-1);
          if (previous && !previous.user) previous.text += " " + item.text;
          else
            output.push({
              id: `${run.id}:${item.id}`,
              user: false,
              text: item.text,
            });
        }
      }
      return [
        ...(run.id === root.id
          ? []
          : [
              {
                id: `${run.id}-input`,
                user: true,
                text:
                  run.input ||
                  run.quote?.text ||
                  run.attachments.map((file) => file.name).join(", "),
              },
            ]),
        ...output,
      ];
    })
    .slice(-3);
  const title = topicTitle(session, root) || t("chat.topic");
  const channelSource = formatChannelOrigin(session.channel, t);
  const channelDelivery =
    latest.channel &&
    (latest.channel.status !== "pending" || !active(latest.status))
      ? latest.channel
      : undefined;
  return (
    <MessageScrollerItem
      className={cn("topic-thread", selected && "is-selected")}
      data-session-id={session.id}
      data-status={latest.status}
    >
      {(channelSource || root.channel) && (
        <p className="text-right text-xs text-muted-foreground">
          {channelSource || t("channels.fromChannel")}
        </p>
      )}
      <UserMessage
        sessionId={session.id}
        message={root}
        archived={agent.archived}
        onQuote={onQuote}
        onForward={onForward}
        onEdit={
          !agent.archived &&
          canEditSentMessage(root) &&
          !activeRuns.some(
            (run) => run.sessionId === session.id && active(run.status),
          )
            ? () => onEdit(root)
            : undefined
        }
        footerActions={
          !agent.archived && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-pressed={pinned}
              aria-label={t("chat.pinTopic")}
              title={t(pinned ? "agents.unpinConversation" : "chat.pinTopic")}
              onClick={() => onPinnedChange(!pinned)}
            >
              <Pin className={cn(pinned && "fill-current")} />
            </Button>
          )
        }
      >
        <Separator />
        {preview.length > 0 && (
          <button
            className="topic-open"
            aria-label={t("chat.openTopic", { title })}
            aria-expanded={selected}
            aria-controls={
              selected
                ? `panel-${encodeURIComponent(`topic:${session.id}`)}`
                : undefined
            }
            onClick={onOpen}
            onPointerEnter={prefetchReplies}
            onFocus={prefetchReplies}
          >
            <ItemGroup className="topic-previews gap-1">
              {preview.map((message) => (
                <Item
                  size="xs"
                  className="topic-preview flex-nowrap p-0"
                  key={message.id}
                >
                  <ItemMedia>
                    {message.user ? (
                      <span className="topic-avatar" aria-hidden="true">
                        <UserRound size={12} />
                      </span>
                    ) : (
                      <AgentAvatar agent={agent} size="sm" />
                    )}
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-row items-baseline group-data-[size=xs]/item:gap-2">
                    {!message.user && (
                      <span className="topic-preview-author">{agent.name}</span>
                    )}
                    <span className="topic-preview-text">{message.text}</span>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </button>
        )}
        {latest.status === "queued" && latest.waitingOn?.length ? (
          <WaitingDependencies
            run={latest}
            compact
            disabled={agent.archived}
            onEdit={!agent.archived ? onEdit : undefined}
            onOpenRun={onOpenRun}
          />
        ) : null}
        {query.error && (
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        )}
        <div className="topic-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="topic-reply-button"
            onClick={onOpen}
            onPointerEnter={prefetchReplies}
            onFocus={prefetchReplies}
          >
            <MessageCircle data-icon="inline-start" />
            {t("chat.replyAction")}
          </Button>
          {latest.status !== "completed" &&
            !(latest.status === "queued" && latest.waitingOn?.length) && (
              <RunStatus
                status={latest.status}
                label={
                  latest.pauseRequested ? t("chat.pausingReply") : undefined
                }
                iconOnly={isWorking(latest.status)}
              />
            )}
          {channelDelivery && (
            <span
              role="status"
              className={cn(
                "text-xs",
                channelDelivery.status === "failed"
                  ? "text-destructive"
                  : channelDelivery.status === "unknown"
                    ? "text-(--status-attention)"
                    : "text-muted-foreground",
              )}
            >
              {t(`channels.reply.${channelDelivery.status}`)}
            </span>
          )}
          {!agent.archived &&
            !latest.channel &&
            !latest.superseded &&
            canRecoverRun(latest.status) && (
              <RunRecoveryButton
                key={latest.id}
                run={latest}
                session={session}
              />
            )}
          {onExpand && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="topic-expand ms-auto"
              aria-label={t("chat.expandTopic")}
              title={t("chat.expandTopic")}
              onClick={onExpand}
              onFocus={prefetchReplies}
              onPointerEnter={prefetchReplies}
            >
              <Maximize2 />
            </Button>
          )}
        </div>
      </UserMessage>
    </MessageScrollerItem>
  );
}

export type TopicConversationProps = {
  compactReply?: boolean;
  positions: MessagePositions;
  sessionId: string;
  agent: Agent;
  onForward: (message: MessageQuote) => void;
  onOpenFile: OpenChatFile;
  onOpenTool: (kind: "files" | "diff" | "terminal") => void;
  onOpenRun: OpenRun;
  onOpenAgent: (id: string) => void;
  onOpenSiblingTopic?: (sessionId: string) => void;
  onLocate?: (session: Session) => void;
  onLocateChannel?: (channel: string) => void;
  focus: boolean;
  onFocused: () => void;
  revealKey?: number;
  revealRun?: string;
  onRevealed: () => void;
  visible: boolean;
  enabled: boolean;
  lastReadCursor?: number;
  unreadSequence?: number;
  onRead: (sessionId: string, cursor: number) => void;
};

export function TopicConversation(props: TopicConversationProps) {
  const view = useQuery({
    ...sessionQuery(props.sessionId),
    enabled: props.enabled,
    subscribed: props.enabled,
  });
  if (!view.data)
    return view.error ? (
      <ErrorNotice error={view.error} retry={() => void view.refetch()} />
    ) : (
      <Loading />
    );
  return (
    <MessageScrollerProvider
      key={props.sessionId}
      active={props.enabled}
      historyId={`topic:${props.sessionId}`}
      positions={props.positions}
    >
      <ImagePreviewProvider>
        <TopicConversationContent {...props} {...view.data} />
      </ImagePreviewProvider>
    </MessageScrollerProvider>
  );
}

const topicRowKey = (row: Run | TopicSource) =>
  "message" in row ? row.message.id : row.id;

function TopicConversationContent({
  onForward,
  onOpenFile,
  onOpenTool,
  onOpenRun,
  onOpenAgent,
  onOpenSiblingTopic,
  onLocate,
  onLocateChannel,
  focus,
  onFocused,
  revealKey,
  revealRun,
  onRevealed,
  visible,
  enabled,
  lastReadCursor = 0,
  unreadSequence = 0,
  onRead,
  ...props
}: TopicConversationProps & SessionView) {
  const { t } = useTranslation();
  const composer = useContext(ComposerContext);
  const preview = useImagePreview();
  const { session, agent } = props;
  const handoffFrom = session.handoffFrom;
  const { data: overview } = useChatActivity(session.chatId, enabled);
  const { data: handoffSourceTitle } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
    enabled: enabled && Boolean(handoffFrom),
    select: (data) => {
      if (!handoffFrom) return "";
      if (handoffFrom.kind === "topic") {
        return (
          data.conversations.find((item) => item.id === handoffFrom.sessionId)
            ?.title ?? ""
        );
      }
      const parentChat = data.chats.find((item) => item.id === session.chatId);
      return parentChat ? displayChatTitle(parentChat, t) : "";
    },
  });
  const { data: delegations } = useQuery({
    ...chatDelegationsQuery(session.chatId),
    enabled,
    subscribed: enabled,
  });
  const query = useInfiniteQuery({
    ...sessionRunsQuery(session.id),
    enabled,
    subscribed: enabled,
  });
  const runs = useMemo(
    () =>
      mergeTopicRuns(
        session.id,
        props.root,
        query.data?.pages.flatMap((page) => page.runs) ?? [],
        overview?.runs ?? [],
      ),
    [session.id, props.root, query.data?.pages, overview?.runs],
  );
  const gitRoots = useGitRoots(
    agent.id,
    session.workingCopyId || session.comparison ? session.roots : undefined,
    session.id,
  );
  const cwd = session.roots.find(
    (root) => root.id === session.primaryRootId,
  )?.path;
  const readCursor = query.isSuccess ? query.data.pages[0]?.cursor : undefined;
  useEffect(() => {
    if (visible && !preview.file && readCursor !== undefined)
      onRead(session.id, readCursor);
  }, [session.id, visible, preview.file, readCursor, onRead]);
  const scroller = useMessageScroller();
  const rows = useMemo(
    () => (props.source ? [props.source, ...runs] : runs),
    [props.source, runs],
  );
  const quote = composer?.quote;
  const edit = composer?.edit;
  const onQuote = useCallback(
    (message: MessageQuote) => quote?.(session.id, message),
    [session.id, quote],
  );
  const onEdit = useCallback(
    (run: Run) => edit?.(session.id, run),
    [session.id, edit],
  );
  const activeRun = overview?.runs.find(
    (run) => run.sessionId === session.id && active(run.status),
  );
  const latestRun = runs.at(-1);
  const pausedRun = overview?.runs.find(
    (run) => run.sessionId === session.id && run.status === "paused",
  );
  const resumableRun =
    pausedRun ??
    (!activeRun && latestRun && canContinueRun(latestRun, session)
      ? latestRun
      : undefined);
  const panel = useRef<HTMLElement>(null);
  useUnreadStart({
    active: enabled,
    ready: !!overview && !!query.data,
    suppressed: !!revealRun,
    readCursor: lastReadCursor,
    unreadSequence,
    latestCursor: readCursor,
    runs,
    view: query,
  });
  useRevealEntry(
    panel,
    revealRun,
    enabled && !!overview && !!revealRun,
    query,
    onRevealed,
    visible,
    revealKey,
    "start",
  );
  useFocusComposer(panel, focus, onFocused);
  const channelOrigin =
    session.channel && session.channel.channel !== "feishu"
      ? session.channel
      : undefined;
  const channelNotice = channelOrigin
    ? [formatChannelOrigin(channelOrigin, t), t("personal.conversation")]
        .filter(Boolean)
        .join(" · ")
    : "";
  if (!overview) return <Loading />;
  const handoffLabelTitle =
    handoffSourceTitle ||
    (handoffFrom?.kind === "topic" ? t("chat.topic") : t("workspace.chat"));
  return (
    <section
      ref={panel}
      className="topic-conversation"
      aria-label={t("chat.topic")}
    >
      {channelOrigin && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={channelNotice}
          >
            {channelNotice}
          </span>
          {onLocateChannel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onLocateChannel(channelOrigin.channel)}
            >
              {t("channels.settings")}
            </Button>
          )}
        </div>
      )}
      {(onLocate ||
        handoffFrom ||
        session.workingCopyId ||
        session.comparison) && (
        <div className="topic-toolbar">
          {onLocate && (
            <Button variant="ghost" size="sm" onClick={() => onLocate(session)}>
              <ArrowLeft data-icon="inline-start" />
              {t(
                session.taskId
                  ? "tasks.backToTask"
                  : session.comparison
                    ? "comparison.back"
                    : "chat.locateTopic",
              )}
            </Button>
          )}
          {handoffFrom && (
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 max-w-64 text-muted-foreground"
              title={t("context.handoffFrom", { title: handoffLabelTitle })}
              onClick={() =>
                onOpenRun(
                  {
                    chatId: session.chatId,
                    sessionId: handoffFrom.sessionId,
                    runId: handoffFrom.upToRunId ?? "",
                    agentId: session.agentId,
                    topic: handoffFrom.kind === "topic",
                  },
                  handoffLabelTitle,
                )
              }
            >
              <CornerUpLeft data-icon="inline-start" />
              <span className="truncate">
                {t("context.handoffFrom", { title: handoffLabelTitle })}
              </span>
            </Button>
          )}
          {(session.workingCopyId || session.comparison) && (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span
                className="max-w-48 truncate px-1 text-xs text-muted-foreground"
                title={cwd}
              >
                {session.workingCopyName || cwd?.split(/[/\\]/).at(-1)}
              </span>
              {(["files", "diff", "terminal"] as const)
                .filter((kind) => kind !== "diff" || !!gitRoots.data?.length)
                .map((kind) => (
                  <Button
                    key={kind}
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenTool(kind)}
                  >
                    {t(`workspace.${kind}`)}
                  </Button>
                ))}
            </div>
          )}
        </div>
      )}
      {!query.data ? (
        <div className="min-h-0 flex-1">
          {query.error ? (
            <ErrorNotice
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : (
            <Loading />
          )}
        </div>
      ) : (
        <MessageTimeline
          items={rows}
          itemKey={topicRowKey}
          busy={
            query.isFetchingNextPage ||
            (!!activeRun && isWorking(activeRun.status))
          }
          inert={!!preview.file}
          overlay={<ImagePreview />}
          onLoadEarlier={
            query.hasNextPage && !query.isFetching && !query.error
              ? () => void query.fetchNextPage({ cancelRefetch: false })
              : undefined
          }
          notice={
            query.error && (
              <ErrorNotice
                error={query.error}
                retry={() =>
                  void (query.isFetchNextPageError
                    ? query.fetchNextPage()
                    : query.refetch())
                }
              />
            )
          }
        >
          {(run) =>
            "message" in run ? (
              <TopicSourceContent
                source={run}
                session={session}
                agent={agent}
                onOpenFile={onOpenFile}
                onQuote={onQuote}
                onForward={onForward}
              />
            ) : (
              <RunContent
                showRuntimeHandoff={
                  run !== runs[0] || (!props.source && !session.handoffFrom)
                }
                run={run}
                agent={agent}
                session={session}
                onOpenFile={onOpenFile}
                agents={overview.agents}
                delegatedRuns={delegations?.outgoing[run.id]}
                onOpenRun={onOpenRun}
                onOpenAgent={onOpenAgent}
                requests={overview.requests}
                sessionBusy={!!activeRun}
                canRecover={run.id === latestRun?.id}
                onQuote={onQuote}
                onForward={onForward}
                onEdit={onEdit}
              />
            )
          }
        </MessageTimeline>
      )}
      <footer className="topic-composer-wrap">
        <ActiveDelegationsBar
          chatId={session.chatId}
          sessionId={session.id}
          delegations={delegations}
          sessionRuns={runs}
          agents={overview.agents}
          requests={overview.requests}
          onOpenRun={onOpenRun}
        />
        <Composer
          agentId={agent.id}
          chatId={session.chatId}
          session={session}
          profile={agent.profile}
          reply
          compact={props.compactReply}
          activeRun={activeRun}
          resumableRun={resumableRun}
          queuedRuns={overview.runs.filter(
            (run) =>
              run.sessionId === session.id &&
              run.status === "queued" &&
              !(props.root?.status === "queued" && run.id === props.root.id),
          )}
          hasActiveDelegations={selectSessionDelegations(
            delegations,
            session.id,
            runs,
          ).some((d) => isDelegatedRunActive(d.status))}
          hasHistory={
            Boolean(props.source) ||
            runs.some(
              (run) => run.status !== "queued" && run.status !== "cancelled",
            )
          }
          lastCompacted={latestRun?.input.trim().startsWith("/compact")}
          archived={agent.archived}
          visible={enabled}
          onSent={() =>
            requestAnimationFrame(() => scroller.current?.scrollToEnd())
          }
          onOpenHandoffTopic={(run) => {
            if (onOpenSiblingTopic) onOpenSiblingTopic(run.sessionId);
            else
              onOpenRun(
                {
                  chatId: run.chatId,
                  sessionId: run.sessionId,
                  runId: run.id,
                  agentId: run.agentId,
                  topic: true,
                },
                run.input,
              );
          }}
        />
      </footer>
    </section>
  );
}
