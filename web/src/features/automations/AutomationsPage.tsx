import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  Clock3,
  InfinityIcon,
  Mail,
  Plus,
  Search,
  Webhook,
  Zap,
} from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { queryClient } from "@/api/client";
import type { Agent, Automation, Chat, TaskExecution } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SecondarySidebar,
  useSecondarySidebarState,
} from "@/components/workbench/SecondarySidebar";
import { pluginsQuery } from "@/features/plugins/pluginsQuery";
import { AutomationDetails } from "./AutomationDetails";
import {
  AutomationEditor,
  eventSourceKey,
  type EventSourceOption,
} from "./AutomationEditor";
import { intervalParts, isWorkweek, weekdayOrder } from "./automationSchedule";
import { automationsQuery } from "./automationsQuery";
import "./automations.css";

function triggerLabel(plan: Automation, t: TFunction) {
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

function nextLabel(
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

export default function AutomationsPage({
  agents,
  chats,
  selectedId,
  onSelect,
  onOpenChat,
}: {
  agents: Agent[];
  chats: Chat[];
  selectedId?: string;
  onSelect: (id?: string) => void;
  onOpenChat: (run: TaskExecution, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { compact, sidebar, setSidebar } = useSecondarySidebarState();
  const [search, setSearch] = useState("");
  const [editor, edit] = useState<"new" | Automation>();
  const [now, setNow] = useState(Date.now);
  const plans = useQuery({ ...automationsQuery, refetchOnWindowFocus: true });
  const plugins = useQuery(pluginsQuery);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const sources: EventSourceOption[] = (plugins.data ?? []).flatMap((plugin) =>
    (plugin.manifest.contributes.eventSources ?? []).map((contribution) => ({
      pluginId: plugin.id,
      contribution,
      enabled: plugin.enabled && plugin.installed,
      label: t("plugins.eventType." + plugin.id + "/" + contribution.id, {
        defaultValue: contribution.name,
      }),
    })),
  );
  const rows = (plans.data ?? []).map((plan) => {
    const chat = chats.find(
      (item) => item.id === (plan.destination.chatId || plan.boundChatId),
    );
    const agent = agents.find(
      (item) => item.id === (plan.destination.agentId || chat?.agentId),
    );
    const source = plan.trigger.source;
    const kind =
      plan.trigger.kind === "schedule"
        ? t("automations.schedule")
        : source
          ? (sources.find(
              ({ pluginId, contribution }) =>
                pluginId + "/" + contribution.id === eventSourceKey(source),
            )?.label ?? source.contributionId)
          : t("automations.webhook");
    const timing = triggerLabel(plan, t);
    return { plan, agent, chat, kind, timing };
  });
  const firstId =
    rows.find(({ plan }) => plan.enabled)?.plan.id ?? rows[0]?.plan.id;
  const selected = rows.find(({ plan }) => plan.id === (selectedId ?? firstId));
  useEffect(() => {
    if (!selectedId && firstId) onSelect(firstId);
  }, [selectedId, firstId, onSelect]);
  const term = search.trim().toLocaleLowerCase();
  const shown = rows.filter(({ plan, agent, kind, timing }) =>
    [
      plan.name,
      agent?.name,
      t("automations." + plan.trigger.kind),
      kind,
      timing,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(term),
  );
  function select(id: string) {
    onSelect(id);
    if (compact) setSidebar(false);
  }
  return (
    <section
      className="workspace-frame automations-page"
      data-sidebar={sidebar}
      aria-label={t("nav.automations")}
    >
      <SecondarySidebar
        id="automation-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <header className="sidebar-heading">
          <h1>{t("nav.automations")}</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("automations.create")}
            title={t("automations.create")}
            onClick={() => edit("new")}
          >
            <Plus />
          </Button>
        </header>
        <div className="automation-search">
          <InputGroup className="sidebar-search-control">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={search}
              aria-label={t("automations.search")}
              placeholder={t("automations.search")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
        </div>
        <nav className="automation-nav" aria-label={t("automations.plans")}>
          {plans.isPending ? (
            <div className="grid gap-3 px-2 py-3" aria-hidden="true">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : (
            [true, false].map((enabled) => {
              const group = shown.filter(
                ({ plan }) => plan.enabled === enabled,
              );
              if (!group.length) return null;
              const label = t(
                enabled ? "automations.enabled" : "automations.paused",
              );
              return (
                <section className="automation-nav-group" key={String(enabled)}>
                  <h2>
                    {label} <span>{group.length}</span>
                  </h2>
                  <ul aria-label={label}>
                    {group.map(({ plan, kind, timing }) => (
                      <AutomationNavItem
                        key={plan.id}
                        plan={plan}
                        subtitle={
                          plan.trigger.kind === "schedule" ? timing : kind
                        }
                        selected={selected?.plan.id === plan.id}
                        onSelect={select}
                      />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
          {term && plans.data && !shown.length && (
            <p className="automation-no-matches">{t("tasks.noMatches")}</p>
          )}
        </nav>
      </SecondarySidebar>
      <main
        key={selectedId ?? firstId ?? "empty"}
        className="automation-content"
        inert={compact && sidebar}
      >
        {plans.isPending ? (
          <Loading />
        ) : plans.error && !plans.data ? (
          <ErrorNotice error={plans.error} retry={() => void plans.refetch()} />
        ) : selected ? (
          <AutomationDetails
            {...selected}
            next={nextLabel(selected.plan, t, i18n.language, now)}
            onEdit={() => edit(selected.plan)}
            onArchived={() => {
              queryClient.setQueryData<Automation[]>(
                automationsQuery.queryKey,
                (cached) => cached?.filter(({ id }) => id !== selected.plan.id),
              );
              onSelect(undefined);
            }}
            onOpenChat={onOpenChat}
          />
        ) : (
          <Empty>
            <EmptyMedia variant="icon">
              <InfinityIcon />
            </EmptyMedia>
            <EmptyTitle>
              {t(selectedId ? "automations.unavailable" : "automations.empty")}
            </EmptyTitle>
            {firstId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => select(firstId)}
              >
                {t("automations.otherPlans")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => edit("new")}>
                <Plus data-icon="inline-start" />
                {t("automations.create")}
              </Button>
            )}
          </Empty>
        )}
      </main>
      {editor && (
        <AutomationEditor
          plan={editor === "new" ? undefined : editor}
          agents={agents.filter((agent) => !agent.archived)}
          chats={chats.filter((chat) => !chat.channel)}
          eventSources={sources}
          onClose={() => edit(undefined)}
          onSaved={(plan) => {
            queryClient.setQueryData<Automation[]>(
              automationsQuery.queryKey,
              (cached) =>
                cached?.some(({ id }) => id === plan.id)
                  ? cached.map((item) =>
                      item.id === plan.id ? { ...item, ...plan } : item,
                    )
                  : [plan, ...(cached ?? [])],
            );
            void plans.refetch();
            setSearch("");
            select(plan.id);
            edit(undefined);
          }}
        />
      )}
    </section>
  );
}

function AutomationNavItem({
  plan,
  subtitle,
  selected,
  onSelect,
}: {
  plan: Automation;
  subtitle: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const source = plan.trigger.source;
  const Icon =
    plan.trigger.kind === "schedule"
      ? Clock3
      : source?.pluginId === "lever.imap-mail"
        ? Mail
        : source
          ? Zap
          : Webhook;
  const status = plan.recentRuns?.[0]?.status;
  const issue =
    plan.error ||
    plan.sourceError ||
    (plan.sourceDisabled && t("automations.sourceDisabled")) ||
    ((status === "failed" || status === "waiting_user") &&
      t("status." + status));
  return (
    <li>
      <Button
        variant="ghost"
        className="sidebar-nav-item automation-nav-row"
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(plan.id)}
        title={plan.name}
      >
        <Icon aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{plan.name}</span>
          <span className="automation-nav-timing truncate">{subtitle}</span>
        </span>
        {issue && (
          <span className="automation-nav-issue" title={issue}>
            <CircleAlert aria-hidden="true" />
            <span className="sr-only">{issue}</span>
          </span>
        )}
      </Button>
    </li>
  );
}
