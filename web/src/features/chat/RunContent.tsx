import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, CircleAlert, CircleUser, GitBranch } from "lucide-react";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  DelegatedRun,
  Request,
  Run,
  Session,
  TimelineEntry,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  MessageScrollerItem,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { ErrorNotice } from "@/components/common";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RequestCard } from "./RequestCard";
import { useRunResponse } from "./useRunResponse";
import { canRecoverRun, RunRecoveryButton } from "./RunRecoveryButton";
import { isWorking, RunStatus } from "./RunStatus";
import { MessageActions, type MessageActionHandlers } from "./MessageActions";
import { subagentTitle } from "./RunWork";
import { DelegatedTasks, type OpenRun } from "./DelegatedTasks";
import { TurnChanges } from "@/features/diff/TurnChanges";
import { UserMessage } from "./UserMessage";
import type { OpenChatFile } from "./ChatResponse";

export function canEditSentMessage(run: Run) {
  return (
    !run.channel &&
    !run.superseded &&
    !run.comparisonId &&
    ["completed", "failed", "interrupted", "paused"].includes(run.status)
  );
}

type RunContentProps = {
  run: Run;
  agent: Agent;
  agents: Agent[];
  delegatedRuns?: DelegatedRun[];
  onOpenRun: OpenRun;
  onOpenAgent: (id: string) => void;
  session: Session;
  onOpenFile: OpenChatFile;
  requests: Request[];
  sessionBusy: boolean;
  showRuntimeHandoff?: boolean;
  onEdit?: (run: Run) => void;
  sourceTopicId?: string;
  onOpenSourceTopic?: (
    entry: Pick<TimelineEntry, "runId" | "sourceTopicId">,
  ) => void;
  openingSourceTopic?: boolean;
} & MessageActionHandlers;

export const RunContent = memo(function RunContent(props: RunContentProps) {
  const { run } = props;
  return (
    <MessageScrollerItem
      className="run-content outline-none focus-visible:bg-accent/40"
      tabIndex={-1}
      data-run-id={run.id}
      data-session-id={props.sourceTopicId}
      data-status={run.status}
    >
      <RunMessages {...props} />
    </MessageScrollerItem>
  );
});

function RunMessages({
  run,
  agent,
  agents,
  delegatedRuns,
  onOpenRun,
  onOpenAgent,
  session,
  onOpenFile,
  requests,
  sessionBusy,
  showRuntimeHandoff = true,
  onQuote,
  onForward,
  onEdit,
  sourceTopicId,
  onOpenSourceTopic,
  openingSourceTopic,
}: RunContentProps) {
  const { t } = useTranslation();
  const scroller = useMessageScroller();
  const resolve = useMutation({
    mutationFn: () =>
      api(`/runs/${run.id}/resolve`, { confirmedStopped: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
  const [confirmStopped, setConfirmStopped] = useState(false);
  const recovery = !agent.archived &&
    !run.channel &&
    !run.superseded &&
    canRecoverRun(run.status) && (
      <RunRecoveryButton
        run={run}
        disabled={sessionBusy}
        onRetried={() =>
          requestAnimationFrame(() => scroller.current?.scrollToEnd())
        }
      />
    );
  const retryReply = useMutation({
    mutationFn: () => api(`/runs/${run.id}/channel-reply/retry`, {}),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
  });
  const output = run.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("\n\n");
  const pendingRequests = requests.filter(
    (request) => request.runId === run.id,
  );
  const delegateApprovals = pendingRequests.filter(
    (request) => request.delegationAgentId,
  );
  const topicLabel = t(sourceTopicId ? "chat.openSourceTopic" : "chat.toTopic");
  const topicAction = onOpenSourceTopic && (
    <Button
      type="button"
      variant="ghost"
      size={sourceTopicId ? "xs" : "icon-xs"}
      aria-label={topicLabel}
      title={topicLabel}
      disabled={openingSourceTopic}
      onClick={() => onOpenSourceTopic({ runId: run.id, sourceTopicId })}
    >
      <GitBranch data-icon={sourceTopicId ? "inline-start" : undefined} />
      {sourceTopicId && topicLabel}
    </Button>
  );
  const createTopicAction = sourceTopicId ? undefined : topicAction;
  const { body, work, subagents, runtimeName } = useRunResponse({
    run,
    session,
    agent,
    requests: pendingRequests,
    onOpenFile,
    onQuote,
    onForward,
    userFooterActions: createTopicAction,
  });
  const hasCollaboration = !!(
    delegatedRuns?.length ||
    delegateApprovals.length ||
    subagents.length
  );
  return (
    <>
      {run.channel && (
        <p className="text-right text-xs text-muted-foreground">
          {t("channels.fromChannel")}
        </p>
      )}
      <UserMessage
        chatId={run.chatId}
        sessionId={run.sessionId}
        message={run}
        archived={agent.archived}
        onQuote={onQuote}
        onForward={onForward}
        footerActions={createTopicAction}
        onEdit={
          onEdit && !agent.archived && !sessionBusy && canEditSentMessage(run)
            ? () => onEdit(run)
            : undefined
        }
      />
      {run.handoff && showRuntimeHandoff && (
        <div className="runtime-handoff">
          <RuntimeIcon provider={run.selection.provider} size={14} />
          {t("models.handoff", {
            runtime: runtimeName,
          })}
        </div>
      )}
      <Message className="agent-message" aria-label={agent.name}>
        <MessageContent className="gap-4">
          <MessageHeader className="agent-author gap-2 px-0">
            <AgentAvatar agent={agent} size="sm" />
            <span className="truncate">{agent.name}</span>
          </MessageHeader>
          {!hasCollaboration && work}
          {body}
          {run.createdAgents?.map(({ agentId, name }) => {
            const created = agents.find((agent) => agent.id === agentId);
            return (
              <Button
                key={agentId}
                type="button"
                variant="outline"
                className="h-auto min-h-11 w-full justify-start gap-2 bg-(--panel-background) px-3 py-2 text-left whitespace-normal"
                onClick={() => onOpenAgent(agentId)}
              >
                {created ? (
                  <AgentAvatar agent={created} size="sm" />
                ) : (
                  <CircleUser
                    className="size-5 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 wrap-break-word">
                  {t("chat.agentCreated", { name })}
                </span>
                <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                  {t("chat.openCreatedAgent")}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </span>
              </Button>
            );
          })}
          <DelegatedTasks
            runs={delegatedRuns}
            approvals={delegateApprovals}
            agents={agents}
            onOpenRun={onOpenRun}
          />
          {hasCollaboration && work}
          {pendingRequests
            .filter((request) => !request.delegationAgentId)
            .map((request) => {
              const title =
                request.subagentId &&
                subagentTitle(
                  subagents.find((item) => item.id === request.subagentId),
                );
              return (
                <RequestCard
                  key={request.id}
                  request={request}
                  source={
                    request.subagentId
                      ? title
                        ? t("chat.requestFromNamedSubagent", { title })
                        : t("chat.requestFromSubagent")
                      : undefined
                  }
                />
              );
            })}
          {run.error && run.status !== "unknown" && (
            <Alert
              variant={run.status === "interrupted" ? "default" : "destructive"}
            >
              <CircleAlert />
              <AlertTitle>
                {t(`status.${run.status}`, { defaultValue: run.status })}
              </AlertTitle>
              <AlertDescription className="whitespace-pre-wrap break-words">
                {run.error}
              </AlertDescription>
              {recovery && <AlertAction>{recovery}</AlertAction>}
            </Alert>
          )}
          {run.status === "unknown" && (
            <Alert>
              <CircleAlert />
              <AlertTitle>{t("status.unknown")}</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                {run.error && (
                  <div className="whitespace-pre-wrap break-words">
                    {run.error}
                  </div>
                )}
                <Field orientation="horizontal">
                  <Checkbox
                    id={`stopped-${run.id}`}
                    checked={confirmStopped}
                    onCheckedChange={(value) =>
                      setConfirmStopped(value === true)
                    }
                  />
                  <FieldLabel htmlFor={`stopped-${run.id}`}>
                    {t("chat.confirmStopped")}
                  </FieldLabel>
                </Field>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={!confirmStopped || resolve.isPending}
                  onClick={() => resolve.mutate()}
                >
                  {t("chat.markStopped")}
                </Button>
                {resolve.error && <ErrorNotice error={resolve.error} />}
              </AlertDescription>
            </Alert>
          )}
          {!run.error &&
            run.status !== "unknown" &&
            run.status !== "completed" &&
            !isWorking(run.status) && (
              <div className="flex flex-wrap items-center gap-2">
                <RunStatus status={run.status} />
                {recovery}
              </div>
            )}
          {run.channel &&
            (run.channel.status !== "pending" || !active(run.status)) && (
              <div
                className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                role="status"
              >
                {t(`channels.reply.${run.channel.status}`)}
                {run.channel.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={retryReply.isPending}
                    onClick={() => retryReply.mutate()}
                  >
                    {t("channels.retryReply")}
                  </Button>
                )}
              </div>
            )}
          {retryReply.error && <ErrorNotice error={retryReply.error} />}
          <TurnChanges run={run} />
          <MessageActions
            chatId={run.chatId}
            message={{
              runId: run.id,
              role: "assistant",
              author: agent.name,
              text: output,
            }}
            timestamp={run.finishedAt}
            disabled={agent.archived}
            onQuote={onQuote}
            onForward={onForward}
            persistentAction={sourceTopicId ? topicAction : undefined}
          >
            {createTopicAction}
          </MessageActions>
        </MessageContent>
      </Message>
    </>
  );
}
