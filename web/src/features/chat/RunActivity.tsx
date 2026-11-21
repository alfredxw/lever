import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Brain,
  CircleX,
  FilePenLine,
  Files,
  FileText,
  ListTodo,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Item } from "@/api/types.gen";
import { CodeSnippet } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message-response";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { isWorking } from "./RunStatus";
import {
  activityDisplayStatus,
  deriveLiveActivity,
  formatToolTarget,
  shouldAutoExpandThinking,
  thoughtSummary,
  toolAction,
  type Action,
} from "./runActivityLogic";

export { activityDisplayStatus };

const actionIcons: Record<Action, typeof Wrench> = {
  command: Terminal,
  edit: FilePenLine,
  list: Files,
  read: FileText,
  search: Search,
  other: Wrench,
};

function liveToolLabel(
  item: Item,
  phase: "running" | "completed",
  t: TFunction,
): string {
  const action = toolAction(item);
  const target = formatToolTarget(item, action);
  if (phase === "running") {
    if (action === "other") {
      return target
        ? t("chat.callingTool", { tool: target })
        : t("chat.toolRunning.other");
    }
    return target
      ? t(`chat.toolRunningTarget.${action}`, { target })
      : t(`chat.toolRunning.${action}`);
  }
  return target
    ? t(`chat.toolCompletedTarget.${action}`, { target })
    : t(`chat.toolCompleted.${action}`);
}

function useFollowLiveScroll(followLive: boolean, signature: string) {
  const ref = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atLiveEdgeRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (followLive && atLiveEdgeRef.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [followLive, signature]);
  return { ref, onScroll };
}

export function RunActivity({
  items,
  runStatus,
  live = false,
  autoExpandThinking = false,
  runningSubagents = 0,
  thinking = false,
}: {
  items: Item[];
  runStatus: string;
  live?: boolean;
  autoExpandThinking?: boolean;
  runningSubagents?: number;
  thinking?: boolean;
}) {
  const { t } = useTranslation();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lastItem = items.at(-1);
  const state = deriveLiveActivity(items, {
    live: live || thinking,
    runStatus,
    runningSubagents,
  });
  const autoExpanded = shouldAutoExpandThinking(items, {
    autoExpandThinking,
    live,
    runStatus,
  });
  const open = userOpen ?? autoExpanded;

  let Icon = Wrench;
  let label: string;
  let titleAttr: string | undefined;

  if (state.mode === "active_tool" && state.liveTool) {
    const action = toolAction(state.liveTool);
    Icon = actionIcons[action];
    label = liveToolLabel(state.liveTool, "running", t);
    titleAttr = state.liveTool.title || label;
  } else if (state.mode === "completed_tool_live" && state.liveTool) {
    const action = toolAction(state.liveTool);
    Icon = actionIcons[action];
    label = liveToolLabel(state.liveTool, "completed", t);
    titleAttr = state.liveTool.title || label;
  } else if (state.mode === "waiting_subagents") {
    Icon = Brain;
    label = t("chat.waitingSubagents", { count: runningSubagents });
  } else if (state.mode === "thinking") {
    Icon = Brain;
    label = (!open && state.thoughtLine) || t("chat.thinking");
  } else if (items.length === 1 && lastItem?.kind === "reasoning") {
    Icon = Brain;
    label = thoughtSummary(lastItem.text) || t("chat.thought");
  } else if (state.counts.size > 0) {
    const onlyAction =
      state.counts.size === 1 ? state.counts.keys().next().value : undefined;
    if (onlyAction) Icon = actionIcons[onlyAction];
    label = Array.from(state.counts, ([kind, count]) =>
      t(kind === "other" ? "chat.toolCalls" : `chat.toolCalls.${kind}`, {
        count,
      }),
    ).join(" · ");
  } else {
    Icon = state.hasReasoning ? Brain : ListTodo;
    label = state.hasReasoning
      ? t("chat.thought")
      : lastItem?.title || t("chat.activity");
  }

  const line = (
    <TraceLine
      status={state.running ? "running" : undefined}
      role={items.length ? undefined : "status"}
    >
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle title={titleAttr || label}>{label}</TraceTitle>
    </TraceLine>
  );

  return (
    <Trace className="run-activity">
      {items.length > 0 ? (
        <TraceCollapsible open={open} onOpenChange={setUserOpen}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="mt-1 mb-0 border-border/70 pl-3">
            <ActivityList
              items={items}
              runStatus={runStatus}
              activeReasoningId={state.activeReasoning?.id}
              followLive={state.running}
            />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        state.running && line
      )}
    </Trace>
  );
}

function ActivityList({
  items,
  runStatus,
  activeReasoningId,
  followLive,
}: {
  items: Item[];
  runStatus: string;
  activeReasoningId?: string;
  followLive: boolean;
}) {
  const { t } = useTranslation();
  const last = items.at(-1);
  const signature = `${items.length}:${last?.id ?? ""}:${last?.text.length ?? 0}:${last?.status ?? ""}`;
  const scroll = useFollowLiveScroll(followLive, signature);
  const reasoningOnly = items.every((item) => item.kind === "reasoning");

  if (reasoningOnly) {
    return (
      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="run-activity-list run-activity-reasoning scrollbar-thin flex max-h-[min(22rem,48dvh)] min-w-0 flex-col gap-3 overflow-y-auto rounded-sm px-1.5 py-1 text-[13px] outline-none focus-visible:bg-accent/30"
        role="region"
        aria-label={t("chat.thought")}
        tabIndex={0}
      >
        {items.map((item) => (
          <div key={item.id} data-kind="reasoning" className="min-w-0">
            <RunActivityText
              text={item.text}
              kind={item.kind}
              status={item.id === activeReasoningId ? "running" : "completed"}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={scroll.ref}
      onScroll={scroll.onScroll}
      data-slot="trace"
      className="run-activity-list scrollbar-thin flex max-h-[min(20rem,45dvh)] w-full min-w-0 flex-col gap-0.5 overflow-y-auto rounded-sm outline-none focus-visible:bg-accent/30 *:shrink-0"
      role="region"
      aria-label={t("chat.activity")}
      tabIndex={0}
    >
      {items.map((item) =>
        item.kind === "reasoning" ? (
          <div
            key={item.id}
            data-kind={item.kind}
            className="flex items-start gap-2 px-1.5 py-0.5 text-[13px]"
          >
            <TraceIcon className="mt-1">
              <Brain />
            </TraceIcon>
            <RunActivityText
              text={item.text}
              kind={item.kind}
              status={item.id === activeReasoningId ? "running" : "completed"}
            />
          </div>
        ) : (
          <RunActivityItem key={item.id} item={item} runStatus={runStatus} />
        ),
      )}
    </div>
  );
}

export function RunActivityItem({
  item,
  runStatus,
  children,
}: {
  item: Item;
  runStatus: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const status =
    item.status === "running" && runStatus !== "running"
      ? runStatus === "completed"
        ? "unknown"
        : runStatus
      : activityDisplayStatus(item);
  const running = status === "running";
  const failed = status === "failed";
  const showExitCode = item.exitCode !== undefined && item.exitCode !== 0;
  const reasoning = item.kind === "reasoning";
  const live = running && (item.kind === "tool" || reasoning);
  const title = reasoning
    ? thoughtSummary(item.text) || t(live ? "chat.thinking" : "chat.thought")
    : item.title || t("chat.tool");
  const Icon = failed
    ? CircleX
    : reasoning
      ? Brain
      : item.kind === "plan"
        ? ListTodo
        : actionIcons[toolAction(item)];
  const line = (
    <TraceLine status={live ? "running" : failed ? "error" : undefined}>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle title={title}>{title}</TraceTitle>
      {!running && status !== "completed" && (
        <TraceDescription>
          {t(`status.${status}`, { defaultValue: status })}
        </TraceDescription>
      )}
    </TraceLine>
  );
  return (
    <TraceCollapsible
      className={item.kind === "tool" ? "tool-item" : undefined}
      data-kind={item.kind}
    >
      {item.text || children || showExitCode ? (
        <>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            {item.text && (
              <RunActivityText
                text={item.text}
                kind={item.kind}
                status={status}
              />
            )}
            {children}
            {showExitCode && (
              <p className="mt-1.5 font-mono text-xs text-muted-foreground first:mt-0">
                {t("chat.toolExitCode", { code: item.exitCode })}
              </p>
            )}
          </TraceCollapsibleContent>
        </>
      ) : (
        line
      )}
    </TraceCollapsible>
  );
}

export function RunActivityText({
  text,
  kind,
  status,
}: Pick<Item, "text" | "kind" | "status">) {
  const { t } = useTranslation();
  return kind === "reasoning" ? (
    <MessageResponse text={text} running={isWorking(status)} />
  ) : (
    <CodeSnippet
      code={text}
      title={t("chat.toolDetails")}
      failed={status === "failed"}
    />
  );
}
