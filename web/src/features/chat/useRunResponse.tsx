import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Agent, Item, Request, Run, Session } from "@/api/types.gen";
import { useProviders } from "@/features/runtime/queries";
import { ChatResponse, type OpenChatFile } from "./ChatResponse";
import type { MessageActionHandlers } from "./MessageActions";
import { RunActivity } from "./RunActivity";
import { RunWork } from "./RunWork";
import { isWorking } from "./RunStatus";
import { UserMessage } from "./UserMessage";

// Keep consecutive activity together until there is a visible message.
function responseParts(items: Item[]) {
  const parts: (Item | Item[])[] = [];
  for (const item of items) {
    if (
      (item.kind === "reasoning" || item.kind === "text") &&
      !item.text.trim()
    ) {
      continue;
    }
    const previous = parts.at(-1);
    if (item.kind === "text" || item.kind === "user") parts.push(item);
    else if (Array.isArray(previous)) previous.push(item);
    else parts.push([item]);
  }
  return parts;
}

export type RunResponseProps = MessageActionHandlers & {
  run: Run;
  session: Session;
  agent?: Agent;
  requests: Request[];
  onOpenFile: OpenChatFile;
  userFooterActions?: ReactNode;
};

export function useRunResponse({
  run,
  session,
  agent,
  requests: pendingRequests,
  onOpenFile,
  onQuote,
  onForward,
  userFooterActions,
}: RunResponseProps) {
  const { t } = useTranslation();
  const providers = useProviders();
  const provider = providers.data?.find(
    (item) => item.id === run.selection.provider,
  );
  const runtimeName = provider?.name ?? run.selection.provider;
  const autoExpandThinking = provider?.type === "antigravity";
  const subagents = run.items.filter((item) => item.kind === "subagent");
  const ordinaryItems = subagents.length
    ? run.items.filter((item) => item.kind !== "subagent")
    : run.items;
  const parts = responseParts(ordinaryItems);
  const lastPart = parts.at(-1);
  const lastItem = Array.isArray(lastPart) ? lastPart.at(-1) : lastPart;
  const activityStatus =
    run.status === "running" && pendingRequests.length
      ? "waiting_user"
      : run.status;
  const runActive =
    (run.status === "starting" || run.status === "running") &&
    pendingRequests.length === 0;
  const runningSubagents = subagents.filter(
    (item) => item.status === "running",
  ).length;
  const streamingFinalText =
    lastItem?.kind === "text" &&
    lastItem.status === "running" &&
    Boolean(lastItem.text.trim());
  const trailingThinking =
    runActive && !Array.isArray(lastPart) && !streamingFinalText;
  const collapseWork =
    run.status === "completed" &&
    !run.items.some((item) => item.kind === "user") &&
    parts.length > 1 &&
    !Array.isArray(lastPart) &&
    lastPart?.kind === "text";
  const earlierParts = collapseWork ? parts.slice(0, -1) : [];
  const workParts = run.continued
    ? earlierParts.filter(Array.isArray)
    : earlierParts;
  const visibleParts = !collapseWork
    ? parts
    : run.continued
      ? parts.filter((part) => !Array.isArray(part))
      : parts.slice(-1);
  const renderPart = (part: Item | Item[]) =>
    Array.isArray(part) ? (
      <RunActivity
        key={part[0].id}
        items={part}
        runStatus={activityStatus}
        live={part === lastPart && runActive}
        autoExpandThinking={autoExpandThinking}
        runningSubagents={runningSubagents}
      />
    ) : part.kind === "user" && part.message ? (
      <div key={part.id}>
        <UserMessage
          chatId={run.chatId}
          sessionId={run.sessionId}
          message={part.message}
          archived={agent?.archived}
          onQuote={onQuote}
          onForward={onForward}
          footerActions={
            part.status === "completed" ? userFooterActions : undefined
          }
        />
        {(part.status === "unknown" || part.status === "running") && (
          <p role="status" className="text-right text-xs text-muted-foreground">
            {t(
              part.status === "running"
                ? "queue.steering"
                : "queue.unconfirmed",
            )}
          </p>
        )}
      </div>
    ) : (
      <ChatResponse
        key={part.id}
        runId={run.id}
        text={part.text}
        citations={part.citations}
        fallbackItems={run.items}
        running={isWorking(run.status) && part.status === "running"}
        session={session}
        agentRoots={agent?.profile.roots}
        onOpenFile={onOpenFile}
      />
    );
  const work = (
    <RunWork
      run={run}
      subagents={subagents}
      requests={pendingRequests}
      runtime={runtimeName}
    >
      {workParts.length ? workParts.map(renderPart) : undefined}
    </RunWork>
  );
  const body = (parts.length > 0 || trailingThinking) && (
    <div className="message-body">
      {visibleParts.map(renderPart)}
      {trailingThinking && (
        <RunActivity
          items={[]}
          runStatus={activityStatus}
          live
          runningSubagents={runningSubagents}
          thinking
        />
      )}
    </div>
  );
  return {
    body,
    work,
    hasWorkDetails: workParts.length > 0 || subagents.length > 0,
    subagents,
    runtimeName,
  };
}
