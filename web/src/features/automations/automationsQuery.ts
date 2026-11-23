import { queryOptions } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { api } from "@/api/client";
import type {
  Automation,
  AutomationEventSource,
  AutomationInput,
  AutomationRun,
  AutomationTarget,
  EventSourceContribution,
  Request,
  TaskExecution,
  TaskWorkflow,
  WorkItem,
} from "@/api/types.gen";
import { intervalParts, isWorkweek, weekdayOrder } from "./automationSchedule";

export const automationPath = "/tasks/automations";

export const automationsQuery = queryOptions({
  queryKey: ["automations"],
  queryFn: ({ signal }) =>
    api<Automation[]>(automationPath, undefined, "GET", signal),
});

export const automationRunsFeedQuery = queryOptions({
  queryKey: ["automation-runs"],
  queryFn: ({ signal }) =>
    api<AutomationRun[]>("/tasks/automation-runs", undefined, "GET", signal),
});

export function automationHistoryQuery(id: string) {
  return queryOptions({
    queryKey: ["automation-runs", id],
    queryFn: ({ signal }) =>
      api<AutomationRun[]>(
        `${automationPath}/${id}/history`,
        undefined,
        "GET",
        signal,
      ),
  });
}

export const automationWorkItemsQuery = queryOptions({
  queryKey: ["work-items"],
  queryFn: ({ signal }) =>
    api<WorkItem[]>("/tasks/work-items", undefined, "GET", signal),
});

export type NotifyPolicy = "always" | "actionable" | "silent";
export type DeliveryMode = "deliver" | "audit" | "propose" | "curate";
export type AutomationPlanTab = "runs" | "config";
export type AutomationConfigSection =
  | "prompt"
  | "targets"
  | "trigger"
  | "output";

export function automationInputFromPlan(
  plan: Automation,
  overrides?: Partial<AutomationInput>,
): AutomationInput {
  const notifyPolicy = overrides?.notifyPolicy ?? notifyPolicyOf(plan);
  return {
    name: plan.name,
    prompt: plan.prompt,
    trigger: plan.trigger,
    destination: plan.destination,
    selection: plan.selection,
    targets: plan.targets,
    notifyPolicy,
    deliveryMode: deliveryModeOf(plan),
    workItem: plan.workItem,
    quiet: notifyPolicy === "silent",
    ...overrides,
  };
}

export type EventSourceOption = {
  pluginId: string;
  contribution: EventSourceContribution;
  label: string;
  enabled: boolean;
};

export function eventSourceKey(source?: AutomationEventSource) {
  return source ? source.pluginId + "/" + source.contributionId : "webhook";
}

export function notifyPolicyOf(plan: Pick<Automation, "notifyPolicy" | "quiet">): NotifyPolicy {
  if (
    plan.notifyPolicy === "always" ||
    plan.notifyPolicy === "actionable" ||
    plan.notifyPolicy === "silent"
  )
    return plan.notifyPolicy;
  return plan.quiet ? "silent" : "always";
}

export function deliveryModeOf(plan: Pick<Automation, "deliveryMode" | "workItem">): DeliveryMode {
  if (
    plan.deliveryMode === "deliver" ||
    plan.deliveryMode === "audit" ||
    plan.deliveryMode === "propose" ||
    plan.deliveryMode === "curate"
  )
    return plan.deliveryMode;
  return plan.workItem ? "propose" : "deliver";
}

export function planTargets(plan: Automation): AutomationTarget[] {
  if (plan.targets?.length) return plan.targets;
  if (!plan.destination.agentId) return [];
  return [
    {
      id: "",
      agentId: plan.destination.agentId,
      chatId: plan.destination.chatId,
      workingCopyId: plan.destination.workingCopyId,
      enabled: true,
    },
  ];
}

export function isSilentOutcome(run: AutomationRun, plan?: Automation) {
  if (run.status === "failed" || run.status === "waiting_user") return false;
  if (run.workItemIds?.length) return false;
  if (run.status === "skipped") return true;
  if (plan && notifyPolicyOf(plan) === "silent" && run.status === "completed")
    return true;
  return false;
}

export function runNeedsAttention(
  run: AutomationRun,
  requests: readonly Request[],
  workItemsById: ReadonlyMap<string, WorkItem>,
  workflows: ReadonlyMap<string, TaskWorkflow>,
  executions: ReadonlyMap<string, TaskExecution>,
) {
  if (run.status === "failed" || run.status === "waiting_user") return true;
  if (
    run.execution?.runId &&
    requests.some((request) => request.runId === run.execution?.runId)
  )
    return true;
  for (const id of run.workItemIds ?? []) {
    const item = workItemsById.get(id);
    if (!item || item.done) continue;
    const workflow = workflows.get(id);
    const execution = executions.get(id);
    if (!workflow?.accepted && !workflow?.closed && !workflow?.queue && !execution)
      return true;
  }
  return false;
}

export function triggerLabel(plan: Pick<Automation, "trigger">, t: TFunction) {
  const schedule = plan.trigger.schedule;
  if (!schedule)
    return t("automations.eventBatch", { count: plan.trigger.batchSize });
  if (schedule.intervalMinutes) {
    const { count, unit } = intervalParts(schedule.intervalMinutes);
    return t("automations.intervalAt." + unit, { count });
  }
  const { date, dayOfMonth, time, weekdays } = schedule;
  if (date) return t("automations.onceAt", { date, time });
  if (dayOfMonth) return t("automations.monthlyAt", { day: dayOfMonth, time });
  if (!weekdays?.length) return t("automations.dailyAt", { time });
  if (isWorkweek(weekdays)) return t("automations.weekdaysAt", { time });
  return t("automations.weeklyAt", {
    days: weekdayOrder
      .filter((day) => weekdays.includes(day))
      .map((day) => t("automations.weekday." + day))
      .join(t("automations.weekdaySeparator")),
    time,
  });
}

export function nextLabel(
  plan: Automation,
  t: TFunction,
  locale: string,
  now: number,
) {
  if (!plan.enabled) return t("automations.paused");
  if (plan.sourceDisabled) return t("automations.sourceDisabled");
  if (plan.sourceError) return t("automations.sourceError");
  if (plan.trigger.kind === "event") {
    if (plan.trigger.source && !plan.sourceReady)
      return t("automations.sourceConnecting");
    return t("automations.pending", { pending: plan.pendingEvents });
  }
  if (!plan.nextAt) return t("automations.finished");
  const minutes = Math.ceil((plan.nextAt * 1000 - now) / 60_000);
  if (minutes < 1) return t("automations.due");
  const relative = new Intl.RelativeTimeFormat(locale, { style: "short" });
  const period = minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute";
  const duration = Math.floor(
    minutes / (period === "day" ? 1440 : period === "hour" ? 60 : 1),
  );
  return t("automations.nextRelative", {
    time: relative.format(duration, period),
  });
}

export function formatRunDuration(
  createdAt?: string,
  finishedAt?: string,
  t?: TFunction,
) {
  if (!createdAt || !finishedAt) return "";
  const ms = Date.parse(finishedAt) - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60)
    return t ? t("chat.durationSeconds", { count: seconds }) : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (!t) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  return rem
    ? `${t("chat.durationMinutes", { count: minutes })} ${t("chat.durationSeconds", { count: rem })}`
    : t("chat.durationMinutes", { count: minutes });
}

export function cleanSummaryText(text?: string) {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatCompactTime(iso: string, locale: string) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const now = new Date();
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  }
  const sameYear = parsed.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "2-digit" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function dayGroupLabel(iso: string, locale: string) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDay = new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diffDays === 0) return rtf.format(0, "day");
  if (diffDays === 1) return rtf.format(-1, "day");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(parsed);
}
