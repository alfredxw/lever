import { memo, useEffect, useState } from "react";
import { CirclePause, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { SharedActivity, SharedMessage } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { AttachmentGroup } from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";
import { ImageAttachment } from "./Attachments";
import { MessageInput } from "./References";
import {
  activityDisplayStatus,
  RunActivityItem,
  RunActivityText,
} from "./RunActivity";
import { formatDuration, RunWorkDetails } from "./RunWork";
import { ChatMarkdown, type ChatFiles } from "./ChatResponse";

type SharedExchange = {
  id: string;
  turnId?: string;
  prompt?: SharedMessage;
  reply: SharedMessage[];
};

export function sharedExchanges(
  messages: SharedMessage[],
  pageAnchors: ReadonlySet<string>,
  activity?: SharedActivity,
) {
  const result: SharedExchange[] = [];
  let exchange: SharedExchange | undefined;
  for (const message of messages) {
    if (
      !exchange ||
      message.role === "user" ||
      (message.turnId && message.turnId !== exchange.turnId)
    ) {
      exchange = { id: message.id, turnId: message.turnId, reply: [] };
      result.push(exchange);
    }
    if (message.role === "user") {
      exchange.prompt = message;
    } else {
      if (pageAnchors.has(message.id)) exchange.id = message.id;
      exchange.reply.push(message);
    }
  }
  if (
    activity &&
    (!exchange || (activity.turnId && activity.turnId !== exchange.turnId))
  ) {
    result.push({
      id: `active:${activity.turnId ?? "shared"}`,
      turnId: activity.turnId,
      reply: [],
    });
  }
  return result;
}

function isAssistantOutput(message: SharedMessage) {
  return (
    message.kind !== "tool" &&
    message.kind !== "reasoning" &&
    (!!message.text.trim() || !!message.images?.length)
  );
}

export const SharedTurn = memo(function SharedTurn({
  turn: { prompt, reply },
  path,
  runtime,
  activity: live,
  files,
}: {
  turn: SharedExchange;
  path: string;
  runtime: string;
  activity?: SharedActivity;
  files?: ChatFiles;
}) {
  const { t } = useTranslation();
  const images = (message: SharedMessage) =>
    message.images?.length ? (
      <AttachmentGroup className="attachment-strip max-w-full items-center">
        {message.images.map((image, index) => (
          <ImageAttachment
            key={image.id}
            image={{
              id: image.id,
              name: image.name || t("attachments.image", { index: index + 1 }),
              src: `/api${path}/images/${encodeURIComponent(image.id)}`,
            }}
          />
        ))}
      </AttachmentGroup>
    ) : undefined;
  const response = (message: SharedMessage) => (
    <div key={message.id} className="flex flex-col gap-2">
      {images(message)}
      {message.text && (
        <ChatMarkdown
          text={message.text}
          endpoint={`/api${path}/preview`}
          files={files}
        />
      )}
    </div>
  );
  // Some native histories have no final phase, and older Lever servers
  // return plain messages. Keep the last reply even when work follows it.
  const output = reply.filter(isAssistantOutput);
  const terminal = output.some((message) => message.kind === "final")
    ? undefined
    : output.filter((message) => message.kind !== "image").at(-1);
  const visible = new Set(
    output.filter(
      (message) =>
        message.kind === "final" ||
        message.kind === "image" ||
        message === terminal,
    ),
  );
  const answer = reply.filter((message) => visible.has(message));
  const work = reply.filter((message) => !visible.has(message));
  const runStatus = live?.status ?? "completed";
  const duration = !live
    ? formatDuration(
        Date.parse(reply.at(-1)?.createdAt ?? "") -
          Date.parse(prompt?.createdAt ?? ""),
        t,
      )
    : undefined;
  const activeTool =
    runStatus === "running"
      ? work
          .filter(
            (message) =>
              message.kind === "tool" && message.status === "running",
          )
          .at(-1)?.title
      : undefined;
  const label = live ? (
    <SharedWorkingLabel
      status={runStatus}
      startedAt={live.startedAt ?? prompt?.createdAt}
      tool={activeTool}
    />
  ) : duration ? (
    t("chat.elapsed", { duration })
  ) : (
    t("chat.activity")
  );
  return (
    <MessageScrollerItem className="run-content" data-status={runStatus}>
      {prompt && (
        <Message
          align="end"
          className="user-message"
          role="group"
          aria-label={t("chat.you")}
        >
          <MessageContent>
            {images(prompt)}
            {prompt.text && (
              <Bubble align="end" variant="muted">
                <BubbleContent>
                  <MessageInput
                    text={prompt.text}
                    previewEndpoint={`/api${path}/preview`}
                  />
                </BubbleContent>
              </Bubble>
            )}
          </MessageContent>
        </Message>
      )}
      {(reply.length > 0 || live) && (
        <Message className="agent-message" role="group" aria-label={runtime}>
          <MessageContent className="gap-3">
            {(work.length > 0 || live) && (
              <RunWorkDetails label={label}>
                {work.length
                  ? work.map((message) =>
                      message.kind === "tool" ||
                      message.kind === "reasoning" ? (
                        <RunActivityItem
                          key={message.id}
                          item={message}
                          runStatus={runStatus}
                        >
                          {message.detailIds?.length ? (
                            <SharedActivityDetail
                              path={path}
                              ids={message.detailIds}
                              message={message}
                              running={
                                runStatus === "running" &&
                                message.status === "running"
                              }
                            />
                          ) : null}
                          {images(message)}
                        </RunActivityItem>
                      ) : (
                        response(message)
                      ),
                    )
                  : undefined}
              </RunWorkDetails>
            )}
            {answer.length > 0 && (
              <div className="message-body">{answer.map(response)}</div>
            )}
          </MessageContent>
        </Message>
      )}
    </MessageScrollerItem>
  );
});

function SharedWorkingLabel({
  status,
  startedAt,
  tool,
}: {
  status: string;
  startedAt?: string;
  tool?: string;
}) {
  const { t } = useTranslation();
  const running = status === "running";
  const start = Date.parse(startedAt ?? "");
  const ticking = running && Number.isFinite(start);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, start]);
  const duration = ticking
    ? formatDuration(Math.max(0, now - start), t)
    : undefined;
  const Icon = running ? LoaderCircle : CirclePause;
  const toolName = tool?.split("\n", 1)[0].trim();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          running && "animate-spin motion-reduce:animate-none",
        )}
      />
      <span className="shrink-0">
        {duration
          ? t("shared.workingFor", { duration })
          : t(`status.${status}`)}
      </span>
      {toolName && (
        <span className="truncate" title={toolName}>
          · {toolName}
        </span>
      )}
    </span>
  );
}

function SharedActivityDetail({
  path,
  ids,
  message,
  running,
}: {
  path: string;
  ids: string[];
  message: SharedMessage;
  running: boolean;
}) {
  const { kind, status } = message;
  const detail = useQuery({
    queryKey: ["shared-detail", path, ids, status],
    queryFn: async ({ signal }) => {
      const parts = await Promise.all(
        ids.map((id) =>
          api<string>(
            `${path}/details/${encodeURIComponent(id)}`,
            undefined,
            "GET",
            signal,
          ),
        ),
      );
      return parts.filter(Boolean).join("\n\n");
    },
    staleTime: running ? 0 : 60_000,
    refetchInterval: running ? 2000 : false,
    retry: false,
  });
  if (detail.error)
    return (
      <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />
    );
  if (detail.data === undefined) return <Loading />;
  return detail.data ? (
    <RunActivityText
      text={detail.data}
      kind={kind}
      status={
        status === "running" && !running
          ? "unknown"
          : activityDisplayStatus(message)
      }
    />
  ) : null;
}
