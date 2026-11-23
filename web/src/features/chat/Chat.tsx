import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  Comparison,
  MessageQuote,
  Run,
  Session,
  SessionView,
  TimelineEntry,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InputGroupButton } from "@/components/ui/input-group";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  type MessagePositions,
  MessageScrollerProvider,
  MessageTimeline,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { ErrorNotice, Loading } from "@/components/common";
import { useEventCallback } from "@/hooks/useEventCallback";
import { useProviders } from "@/features/runtime/queries";
import { useFeishuChannel } from "@/features/plugins/channelQuery";
import { usePreferences } from "@/features/settings/Preferences";
import { Composer } from "./Composer";
import { hasDraggedFiles } from "./composerFiles";
import type { OpenChatFile } from "./ChatResponse";
import { ComparisonMessage } from "./ComparisonMessage";
import { ComposerContext } from "./ComposerContext";
import { QueuedMessages } from "./QueuedMessages";
import { RunContent } from "./RunContent";
import { Topic, type TopicConversationProps } from "./Topic";
import { ChatTopicView } from "./ChatTopicView";
import { useRevealEntry } from "./useRevealEntry";
import { useFocusComposer } from "./useFocusComposer";
import { isWorking } from "./RunStatus";
import {
  chatDelegationsQuery,
  chatQuery,
  sessionQuery,
  useChatActivity,
} from "./queries";
import type { OpenRun } from "./DelegatedTasks";
import {
  ImagePreview,
  ImagePreviewProvider,
  useImagePreview,
} from "./ImagePreview";

type ChatProps = {
  positions: MessagePositions;
  chatId: string;
  agent: Agent;
  onForward: (message: MessageQuote) => void;
  onOpenFile: OpenChatFile;
  onOpenComparisonTopic: (session: Session) => void;
  onOpenRun: OpenRun;
  onOpenAgent: (id: string) => void;
  visible: boolean;
  enabled: boolean;
  focus: boolean;
  onFocused: () => void;
  onRead: (sessionId: string, cursor: number) => void;
  expandedTopicId?: string;
  onSelectTopic: (agentId: string, chatId: string, sessionId?: string) => void;
  onOpenTopicTool: (
    chatId: string,
    sessionId: string,
    kind: Parameters<TopicConversationProps["onOpenTool"]>[0],
  ) => void;
  openTopics: string[];
  onOpenTopic: (view: SessionView, quote?: MessageQuote) => void;
  pinnedTopicIds: ReadonlySet<string>;
  onPinTopic: (id: string, pinned: boolean) => void;
  revealKey?: number;
  revealTopic?: string;
  revealRun?: string;
  revealComparison?: string;
  focusRevealedEntry?: boolean;
  onRevealed: () => void;
  onLocateTask: (id: string) => void;
  onLocateChannel: (channel: string) => void;
};

const timelineKey = (entry: TimelineEntry) => entry.comparisonId || entry.runId;

export const Chat = memo(function Chat(props: ChatProps) {
  return (
    <MessageScrollerProvider
      key={props.chatId}
      historyId={props.chatId}
      positions={props.positions}
      active={props.enabled}
    >
      <ImagePreviewProvider>
        <ChatContent {...props} />
      </ImagePreviewProvider>
    </MessageScrollerProvider>
  );
});

function ChatContent(props: ChatProps) {
  const {
    chatId,
    agent,
    onForward,
    onOpenFile,
    onOpenComparisonTopic,
    onOpenRun,
    onOpenAgent,
    visible,
    enabled,
    focus,
    onFocused,
    onRead,
    openTopics,
    onOpenTopic,
    expandedTopicId,
    onSelectTopic,
    onOpenTopicTool,
    pinnedTopicIds,
    onPinTopic,
    revealKey,
    revealTopic,
    revealRun,
    revealComparison,
    focusRevealedEntry,
    onRevealed,
    onLocateTask,
    onLocateChannel,
  } = props;
  const [returnToTopic, setReturnToTopic] = useState<string>();
  const [writingChat, setWritingChat] = useState(false);
  const onReturned = useCallback(() => setReturnToTopic(undefined), []);
  const reduceMotion = useReducedMotion();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const onExpand = (id: string) => {
    setWritingChat(false);
    onSelectTopic(agent.id, chatId, id);
  };
  const externalReveal = !!(revealTopic || revealRun || revealComparison);
  const inlineTopic = !externalReveal ? expandedTopicId : undefined;
  useEffect(() => {
    if (externalReveal) {
      setReturnToTopic(undefined);
      if (expandedTopicId) onSelectTopic(agent.id, chatId);
    }
  }, [externalReveal, expandedTopicId, onSelectTopic, agent.id, chatId]);
  const { t } = useTranslation();
  const { preferences } = usePreferences();
  const composer = useContext(ComposerContext);
  const quote = composer?.quote;
  const edit = composer?.edit;
  const quoteMessage = useCallback(
    (message: MessageQuote) => quote?.(chatId, message),
    [chatId, quote],
  );
  const editMessage = useCallback(
    (run: Run) => edit?.(chatId, run),
    [chatId, edit],
  );
  const providers = useProviders();
  const preview = useImagePreview();
  const view = useInfiniteQuery({
    ...chatQuery(chatId),
    enabled,
    subscribed: enabled,
  });
  const { data: delegations } = useQuery({
    ...chatDelegationsQuery(chatId),
    enabled,
    subscribed: enabled,
  });
  const { data: overview } = useChatActivity(chatId, enabled);
  const liveRuns = useMemo(
    () => new Map(overview?.runs.map((run) => [run.id, run])),
    [overview?.runs],
  );
  const scroller = useMessageScroller();
  const { entries, sessions, runs, comparisons, hasMainMessages } =
    useMemo(() => {
      const pages = [...(view.data?.pages ?? [])].reverse();
      const entries = pages.flatMap((page) => page.entries);
      return {
        entries,
        sessions: new Map(
          pages.flatMap((page) => page.sessions.map((s) => [s.id, s])),
        ),
        runs: new Map(
          pages.flatMap((page) => page.runs.map((run) => [run.id, run])),
        ),
        comparisons: new Map(
          pages.flatMap((page) =>
            (page.comparisons ?? []).map((item) => [item.id, item]),
          ),
        ),
        hasMainMessages: entries.some((entry) => entry.kind === "main"),
      };
    }, [view.data?.pages]);
  const latestPage = view.data?.pages[0];
  const channel = latestPage?.chat.channel;
  const botChat = channel === "feishu";
  const { data: feishu } = useFeishuChannel(visible && botChat);
  const stop = useMutation({
    mutationFn: (runId: string) => api(`/runs/${runId}/stop`, {}),
    onError: (error) => toast.error(error.message),
  });
  const sourceTopic = useMutation({
    mutationFn: ({
      runId,
      sourceTopicId,
    }: Pick<TimelineEntry, "runId" | "sourceTopicId">) =>
      sourceTopicId
        ? queryClient.fetchQuery(sessionQuery(sourceTopicId))
        : api<SessionView>(`/chats/${chatId}/topics`, { sourceRunId: runId }),
    onSuccess: (topic, { sourceTopicId }) => {
      if (!sourceTopicId) {
        void queryClient.invalidateQueries({ queryKey: ["chat", chatId] });
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
      }
      onOpenTopic(topic);
    },
    onError: (error) => toast.error(error.message),
  });
  const main = latestPage?.sessions.find((session) => session.kind === "main");
  const readCursor = latestPage?.cursor;
  useEffect(() => {
    if (
      visible &&
      !inlineTopic &&
      !preview.file &&
      main &&
      hasMainMessages &&
      readCursor !== undefined
    )
      onRead(main.id, readCursor);
  }, [
    main?.id,
    visible,
    inlineTopic,
    preview.file,
    hasMainMessages,
    readCursor,
    onRead,
  ]);
  const panel = useRef<HTMLDivElement>(null);
  const onSent = useEventCallback(
    (result: Run | Comparison, launchedFromTopicId?: string) => {
      if (!launchedFromTopicId) {
        if (!inlineTopic)
          requestAnimationFrame(() => scroller.current?.scrollToEnd());
        return;
      }
      if (!("operation" in result) || result.operation !== "topic") return;
      const root = panel.current;
      if (
        preferences.openNewTopicOnCreate &&
        enabled &&
        inlineTopic === launchedFromTopicId &&
        root &&
        (document.activeElement === document.body ||
          root.contains(document.activeElement))
      ) {
        onExpand(result.sessionId);
      } else toast.success(t("chat.topicCreated"));
    },
  );
  const topicToReveal = externalReveal ? revealTopic : returnToTopic;
  useFocusComposer(panel, focus && !inlineTopic && !!latestPage, onFocused);
  useRevealEntry(
    panel,
    revealComparison ||
      revealRun ||
      (topicToReveal &&
        entries.find(
          (entry) =>
            entry.sessionId === topicToReveal ||
            entry.sourceTopicId === topicToReveal,
        )?.runId),
    enabled && !!overview && (externalReveal || !!returnToTopic),
    view,
    externalReveal ? onRevealed : onReturned,
    externalReveal ? (visible ? focusRevealedEntry : false) : "expand",
    externalReveal ? revealKey : undefined,
  );
  if (!overview || !latestPage)
    return view.error ? (
      <ErrorNotice error={view.error} retry={() => void view.refetch()} />
    ) : (
      <Loading />
    );
  const { taskId } = latestPage.chat;
  const source = delegations?.source;
  const sender = overview.agents.find((item) => item.id === source?.agentId);
  const activeRun = overview.runs.find(
    (r) => r.sessionId === main?.id && active(r.status),
  );
  const queuedRuns = overview.runs.filter(
    (r) => r.sessionId === main?.id && r.status === "queued",
  );
  const collapseTopic = () => {
    setReturnToTopic(inlineTopic);
    onSelectTopic(agent.id, chatId);
  };
  const topicLauncher = inlineTopic
    ? {
        topicId: inlineTopic,
        backButton: (
          <InputGroupButton
            size="icon-sm"
            aria-label={t("chat.collapseTopic")}
            title={t("chat.collapseTopic")}
            className="topic-collapse text-muted-foreground"
            onClick={collapseTopic}
          >
            <Minimize2 />
          </InputGroupButton>
        ),
      }
    : undefined;
  return (
    <div
      className={inlineTopic ? "chat-panel chat-topic-view" : "chat-panel"}
      ref={panel}
    >
      <motion.div
        key={inlineTopic ? "topic" : "list"}
        className="chat-view-content"
        initial={
          reduceMotion || !mounted.current
            ? false
            : { opacity: 0.55, scale: inlineTopic ? 0.992 : 1.008 }
        }
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
      >
        {inlineTopic ? (
          <ChatTopicView
            {...props}
            sessionId={inlineTopic}
            compactReply={writingChat}
            onReplyFocus={() => setWritingChat(false)}
            onSelect={onExpand}
            onCollapseTopic={collapseTopic}
            onOpenTool={(kind) => onOpenTopicTool(chatId, inlineTopic, kind)}
          />
        ) : (
          <>
            {source && (
              <div className="flex shrink-0 items-center border-b px-3 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0"
                  onClick={() => onOpenRun(source, source.title)}
                >
                  <ArrowLeft data-icon="inline-start" />
                  <span className="truncate">
                    {sender
                      ? t("chat.backToDelegationBy", { agent: sender.name })
                      : t("chat.backToDelegation")}
                  </span>
                </Button>
              </div>
            )}
            {taskId && (
              <div className="flex shrink-0 items-center border-b px-3 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onLocateTask(taskId)}
                >
                  <ArrowLeft data-icon="inline-start" />
                  {t("tasks.backToTask")}
                </Button>
              </div>
            )}
            {channel && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
                <span className="text-xs text-muted-foreground">
                  {t(
                    botChat ? "channels.privateChat" : "personal.conversation",
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onLocateChannel(channel)}
                >
                  {t("channels.settings")}
                </Button>
              </div>
            )}
            <MessageTimeline
              items={entries}
              itemKey={timelineKey}
              className="chat-history"
              busy={
                view.isFetchingNextPage ||
                (!!activeRun && isWorking(activeRun.status))
              }
              inert={!!preview.file}
              overlay={<ImagePreview />}
              onLoadEarlier={
                view.hasNextPage && !view.isFetching && !view.error
                  ? () => void view.fetchNextPage({ cancelRefetch: false })
                  : undefined
              }
              notice={
                view.error && (
                  <ErrorNotice
                    error={view.error}
                    retry={() =>
                      void (view.isFetchNextPageError
                        ? view.fetchNextPage()
                        : view.refetch())
                    }
                  />
                )
              }
              empty={
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageCircle />
                    </EmptyMedia>
                    <EmptyTitle>
                      {channel
                        ? t(
                            feishu && feishu.chatId !== chatId
                              ? "channels.history"
                              : botChat
                                ? "channels.firstMessage"
                                : "personal.first",
                          )
                        : t("chat.welcome", { name: agent.name })}
                    </EmptyTitle>
                    {!channel && (
                      <EmptyDescription>
                        {t("chat.description")}
                      </EmptyDescription>
                    )}
                  </EmptyHeader>
                  {!channel && (
                    <EmptyContent className="flex-row flex-wrap justify-center">
                      <Badge variant="outline">
                        {providers.data?.find(
                          (provider) => provider.id === agent.profile.provider,
                        )?.name ?? agent.profile.provider}
                      </Badge>
                      <Badge variant="outline">{t("common.local")}</Badge>
                      <Badge
                        variant="outline"
                        className="max-w-full"
                        title={
                          agent.profile.roots.find(
                            (r) => r.id === agent.profile.primaryRootId,
                          )?.path
                        }
                      >
                        <span className="truncate">
                          {agent.profile.roots
                            .find((r) => r.id === agent.profile.primaryRootId)
                            ?.path.split(/[\\/]/)
                            .pop()}
                        </span>
                      </Badge>
                    </EmptyContent>
                  )}
                </Empty>
              }
            >
              {(entry) => {
                const comparison =
                  entry.comparisonId && comparisons.get(entry.comparisonId);
                if (comparison) {
                  return (
                    <ComparisonMessage
                      key={comparison.id}
                      comparison={comparison}
                      enabled={enabled}
                      agents={overview.agents}
                      requests={overview.requests}
                      archived={agent.archived}
                      onOpenTopic={onOpenComparisonTopic}
                      onOpenFile={onOpenFile}
                      onQuote={quoteMessage}
                      onForward={onForward}
                    />
                  );
                }
                const run = liveRuns.get(entry.runId) ?? runs.get(entry.runId);
                const session = sessions.get(entry.sessionId);
                if (!run || !session) return null;
                return entry.kind === "topic" ? (
                  <Topic
                    key={entry.runId}
                    session={session}
                    root={run}
                    agent={agent}
                    activeRuns={overview.runs}
                    replyCount={entry.replyCount}
                    enabled={enabled}
                    selected={openTopics.includes(session.id)}
                    pinned={pinnedTopicIds.has(session.id)}
                    onPinnedChange={(pinned) => onPinTopic(session.id, pinned)}
                    onExpand={botChat ? undefined : () => onExpand(session.id)}
                    onOpen={() => onOpenTopic({ session, root: run })}
                    onQuote={(message) =>
                      onOpenTopic({ session, root: run }, message)
                    }
                    onForward={onForward}
                    onEdit={(message) => {
                      onOpenTopic({ session, root: message });
                      composer?.edit(session.id, message);
                    }}
                    onOpenRun={onOpenRun}
                  />
                ) : (
                  <RunContent
                    key={entry.runId}
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
                    onQuote={botChat ? undefined : quoteMessage}
                    onForward={onForward}
                    onEdit={botChat || !edit ? undefined : editMessage}
                    sourceTopicId={entry.sourceTopicId}
                    onOpenSourceTopic={
                      !botChat &&
                      run.status === "completed" &&
                      !run.superseded &&
                      (entry.sourceTopicId || !agent.archived)
                        ? sourceTopic.mutate
                        : undefined
                    }
                    openingSourceTopic={sourceTopic.isPending}
                  />
                );
              }}
            </MessageTimeline>
          </>
        )}
      </motion.div>
      {botChat ? (
        <div className="chat-composer-wrap">
          <QueuedMessages
            runs={queuedRuns}
            activeRun={activeRun}
            disabled={agent.archived}
          />
          <div className="flex flex-wrap items-center justify-center gap-2">
            {topicLauncher?.backButton}
            {feishu?.chatId === chatId && feishu.enabled && !feishu.paused && (
              <p className="text-xs text-muted-foreground">
                {t("channels.continueInFeishu")}
              </p>
            )}
            {activeRun &&
              (isWorking(activeRun.status) ||
                activeRun.status === "waiting_user") && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stop.isPending || activeRun.status === "cancelling"}
                  onClick={() => stop.mutate(activeRun.id)}
                >
                  {t("chat.stop")}
                </Button>
              )}
          </div>
        </div>
      ) : (
        <div
          className="chat-composer-wrap"
          onFocusCapture={(event) => {
            if (inlineTopic && !event.target.closest(".topic-collapse"))
              setWritingChat(true);
          }}
          onDropCapture={(event) => {
            if (inlineTopic && hasDraggedFiles(event.dataTransfer))
              setWritingChat(true);
          }}
        >
          <Composer
            agentId={agent.id}
            agents={overview.agents}
            chatId={chatId}
            topicLauncher={topicLauncher}
            compact={inlineTopic ? !writingChat : undefined}
            session={main}
            profile={agent.profile}
            activeRun={activeRun}
            pausedRun={overview.runs.find(
              (run) => run.sessionId === main?.id && run.status === "paused",
            )}
            queuedRuns={queuedRuns}
            archived={agent.archived}
            visible={enabled}
            onSent={onSent}
          />
        </div>
      )}
    </div>
  );
}
