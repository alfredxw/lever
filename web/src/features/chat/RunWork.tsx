import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleX,
  LoaderCircle,
  Square,
} from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Item, Request, Run } from "@/api/types.gen";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { isWorking } from "./RunStatus";
import { ItemImages } from "./RunActivity";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

export function subagentTitle(item?: Item) {
  return item?.title || item?.subagent?.prompt?.split("\n", 1)[0];
}

export function formatDuration(elapsed: number, t: TFunction) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  const seconds = Math.floor(elapsed / 1000);
  return [
    seconds >= 3600 &&
      t("chat.durationHours", { count: Math.floor(seconds / 3600) }),
    seconds >= 60 &&
      t("chat.durationMinutes", { count: Math.floor(seconds / 60) % 60 }),
    t("chat.durationSeconds", { count: seconds % 60 }),
  ]
    .filter(Boolean)
    .join(" ");
}

export function RunWork({
  run,
  subagents,
  requests,
  runtime,
  previewEndpoint,
  children,
}: {
  run: Run;
  subagents: Item[];
  requests: Request[];
  runtime: string;
  previewEndpoint?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const ticking =
    !run.finishedAt && (isWorking(run.status) || run.status === "waiting_user");
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const elapsed =
    (run.finishedAt ? Date.parse(run.finishedAt) : ticking ? now : NaN) -
    Date.parse(run.startedAt ?? run.createdAt);
  const duration = formatDuration(elapsed, t);
  const label = duration ? t("chat.elapsed", { duration }) : undefined;
  const statusFor = (item: Item) =>
    requests.some(({ subagentId }) => subagentId === item.id)
      ? "waiting_user"
      : item.status;
  const running = subagents.filter(
    (item) => statusFor(item) === "running",
  ).length;
  const waiting = subagents.filter(
    (item) => statusFor(item) === "waiting_user",
  ).length;
  const hasSubagents = subagents.length > 0;
  const summary = hasSubagents
    ? [
        runtime,
        t("chat.subagentCount", { count: subagents.length }),
        running ? t("chat.subagentsRunning", { count: running }) : "",
        waiting ? t("chat.subagentsWaiting", { count: waiting }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  if (!label && !hasSubagents && !children) return null;
  return hasSubagents || children ? (
    <RunWorkDetails
      label={hasSubagents || !label ? t("chat.activity") : label}
      hint={hasSubagents ? undefined : t("chat.elapsedHint")}
      summary={summary}
      defaultOpen={running + waiting > 0}
    >
      {hasSubagents && (
        <Trace
          className="ms-1 gap-0 border-s ps-3"
          aria-label={t("chat.subagentCount", { count: subagents.length })}
        >
          {subagents.map((item) => (
            <SubagentRow
              key={item.id}
              item={item}
              status={statusFor(item)}
              now={now}
              previewEndpoint={previewEndpoint}
            />
          ))}
        </Trace>
      )}
      {children}
    </RunWorkDetails>
  ) : (
    <RunWorkDetails label={label} hint={t("chat.elapsedHint")} />
  );
}

export function RunWorkDetails({
  label,
  hint,
  summary,
  defaultOpen,
  children,
}: {
  label?: ReactNode;
  hint?: string;
  summary?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  if (!children) {
    return (
      <div className="run-work" title={hint}>
        {label}
      </div>
    );
  }
  return (
    <Collapsible className="run-work" defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className="group/run-work-toggle run-work-toggle inline-flex max-w-full items-center gap-1.5 rounded-lg whitespace-nowrap transition-colors duration-150 select-none hover:bg-control-hover hover:text-foreground focus-visible:bg-control-focus focus-visible:text-foreground motion-reduce:transition-none"
        data-subagents={!!summary || undefined}
        title={hint}
      >
        {summary ? (
          <>
            <span className="font-medium text-foreground">{label}</span>
            <span className="min-w-0 whitespace-normal text-left text-xs">
              {summary}
            </span>
          </>
        ) : (
          label
        )}
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-data-[subagents]/run-work-toggle:order-first group-aria-expanded/run-work-toggle:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="message-body pt-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SubagentRow({
  item,
  status,
  now,
  previewEndpoint,
}: {
  item: Item;
  status: string;
  now: number;
  previewEndpoint?: string;
}) {
  const { t } = useTranslation();
  const activity = item.subagent;
  const result = item.text;
  const hasImages = Boolean(previewEndpoint && item.imageFiles?.length);
  const hasDetails = !!(
    activity?.prompt ||
    activity?.progress ||
    result ||
    hasImages
  );
  const end = activity?.finishedAt
    ? Date.parse(activity.finishedAt)
    : status === "running" || status === "waiting_user"
      ? now
      : NaN;
  const duration = activity
    ? formatDuration(end - Date.parse(activity.startedAt), t)
    : undefined;
  const Icon =
    status === "running"
      ? LoaderCircle
      : status === "completed"
        ? CircleCheck
        : status === "failed"
          ? CircleX
          : status === "interrupted"
            ? Square
            : status === "waiting_user"
              ? CirclePause
              : CircleHelp;
  const line = (
    <TraceLine
      className="w-full flex-1 flex-wrap gap-y-0"
      status={status === "failed" ? "error" : undefined}
    >
      <TraceIcon
        className={
          status === "waiting_user" ? "text-(--status-attention)" : undefined
        }
      >
        <Icon
          className={
            status === "running"
              ? "animate-spin motion-reduce:animate-none"
              : undefined
          }
        />
      </TraceIcon>
      <TraceTitle className="flex-1 text-foreground">
        {subagentTitle(item) || t("chat.subagent")}
      </TraceTitle>
      <span className="shrink-0 text-xs tabular-nums">
        {t(`status.${status}`, { defaultValue: status })}
        {duration && ` · ${duration}`}
      </span>
    </TraceLine>
  );
  return hasDetails ? (
    <TraceCollapsible>
      <TraceCollapsibleTrigger className="min-h-9 w-full px-1.5 hover:bg-control-hover">
        {line}
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="my-0 ms-3 grid gap-2 border-s-0 ps-3 pb-2 text-sm">
        {activity?.prompt && (
          <p className="whitespace-pre-wrap">
            <span className="me-2 font-medium">{t("chat.subagentTask")}</span>
            {activity.prompt}
          </p>
        )}
        {result ? (
          <p className="whitespace-pre-wrap">
            <span className="me-2 font-medium">
              {t(
                status === "failed"
                  ? "chat.subagentError"
                  : "chat.subagentResult",
              )}
            </span>
            {result}
          </p>
        ) : (
          activity?.progress && (
            <p className="whitespace-pre-wrap">
              <span className="me-2 font-medium">
                {t("chat.subagentProgress")}
              </span>
              {activity.progress}
            </p>
          )
        )}
        <ItemImages item={item} previewEndpoint={previewEndpoint} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  ) : (
    <div className="flex min-h-9 items-center px-1.5">{line}</div>
  );
}
