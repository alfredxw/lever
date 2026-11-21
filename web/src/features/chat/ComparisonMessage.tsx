import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Columns2, Columns3, Table2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  Agent,
  Comparison,
  ComparisonResult,
  Request,
  Run,
  Session,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { useProviders } from "@/features/runtime/queries";
import { cn } from "@/lib/utils";
import type { OpenChatFile } from "./ChatResponse";
import type { MessageActionHandlers } from "./MessageActions";
import { comparisonQuery } from "./queries";
import { comparisonModelLabel } from "./useComparisonModels";
import { RunStatus } from "./RunStatus";
import { type RunResponseProps, useRunResponse } from "./useRunResponse";
import { UserMessage } from "./UserMessage";

const viewKey = "lever:comparison-view";

export function ComparisonMessage({
  comparison,
  enabled,
  agents,
  requests,
  archived,
  onOpenTopic,
  onOpenFile,
  ...messageActions
}: MessageActionHandlers & {
  comparison: Comparison;
  enabled: boolean;
  agents: Agent[];
  requests: Request[];
  archived?: boolean;
  onOpenTopic: (session: Session) => void;
  onOpenFile: OpenChatFile;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState(() => {
    const saved = localStorage.getItem(viewKey);
    return saved === "columns" || saved === "table" ? saved : "tabs";
  });
  const [tab, setTab] = useState<string>();
  const query = useQuery({
    ...comparisonQuery(comparison.id),
    enabled,
    subscribed: enabled,
  });
  const results = query.data ?? [];
  const completed = results.filter(
    ({ run }) => run.status === "completed",
  ).length;
  const agentFor = (session: Session) =>
    agents.find((agent) => agent.id === session.agentId);
  const identity = (result: ComparisonResult) => {
    const agent = agentFor(result.session);
    return (
      <ComparisonAgent
        agent={agent}
        run={result.run}
        modelName={result.session.comparison?.modelName}
      />
    );
  };
  const open = ({ session, run }: ComparisonResult) => (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      aria-label={t("comparison.openAgentTopic", {
        name: agentFor(session)?.name ?? session.agentId,
      })}
      onClick={() => onOpenTopic(session)}
    >
      {t(
        run.status === "waiting_user" || run.status === "unknown"
          ? "comparison.openTopicToReview"
          : "comparison.openTopic",
      )}
      <ArrowUpRight data-icon="inline-end" />
    </Button>
  );
  const agentDetails = (result: ComparisonResult) => (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {identity(result)}
      {open(result)}
    </div>
  );
  const reply = ({ run, session }: ComparisonResult) => (
    <ComparisonReply
      key={run.id}
      run={run}
      session={session}
      agent={agentFor(session)}
      requests={requests.filter((request) => request.runId === run.id)}
      onOpenFile={onOpenFile}
      {...messageActions}
    />
  );
  return (
    <MessageScrollerItem
      data-comparison-id={comparison.id}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3"
    >
      <UserMessage
        chatId={comparison.chatId}
        message={comparison.message}
        archived={archived}
        {...messageActions}
      />
      <section
        className="comparison-panel min-w-0 rounded-xl border bg-background"
        aria-label={t("comparison.title")}
      >
        <div className="comparison-toolbar sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-t-xl border-b bg-background px-3 py-2">
          <h3 className="mr-auto flex items-center gap-2 text-sm font-medium">
            <Columns2 className="size-4" />
            {t("comparison.title")}
          </h3>
          <span
            className="text-xs text-muted-foreground tabular-nums"
            role="status"
          >
            {t("comparison.completed", {
              count: completed,
              total: comparison.sessionIds.length,
            })}
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={view}
            onValueChange={(value) => {
              if (!value) return;
              setView(value);
              localStorage.setItem(viewKey, value);
            }}
            aria-label={t("comparison.view")}
          >
            <ToggleGroupItem value="tabs">
              <Columns2 data-icon="inline-start" />
              {t("comparison.tabs")}
            </ToggleGroupItem>
            <ToggleGroupItem value="table">
              <Table2 data-icon="inline-start" />
              {t("comparison.table")}
            </ToggleGroupItem>
            <ToggleGroupItem value="columns">
              <Columns3 data-icon="inline-start" />
              {t("comparison.columns")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {query.error && (
          <div className="p-3">
            <ErrorNotice
              error={query.error}
              retry={() => void query.refetch()}
            />
          </div>
        )}
        {query.isPending && (
          <div className="p-3">
            <Loading />
          </div>
        )}
        {results.length > 0 &&
          (view === "tabs" ? (
            <Tabs
              value={tab ?? results[0].session.id}
              onValueChange={setTab}
              className="min-w-0 gap-0"
            >
              <div className="min-w-0 overflow-x-auto px-3">
                <TabsList
                  className="mt-2 justify-start"
                  aria-label={t("comparison.agents")}
                >
                  {results.map(({ session }) => {
                    const agent = agentFor(session);
                    return (
                      <TabsTrigger
                        key={session.id}
                        value={session.id}
                        className="max-w-48 shrink-0"
                      >
                        {agent && <AgentAvatar agent={agent} size="sm" />}
                        <span className="truncate">
                          {agent?.name ?? session.agentId}
                        </span>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </div>
              {results.map((result) => (
                <TabsContent
                  key={result.session.id}
                  value={result.session.id}
                  className="min-w-0 px-3 pb-4"
                >
                  <div className="my-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="mr-auto min-w-0">{identity(result)}</div>
                    {open(result)}
                  </div>
                  {reply(result)}
                </TabsContent>
              ))}
            </Tabs>
          ) : view === "columns" ? (
            <div
              className="max-w-full overflow-x-auto overscroll-x-contain"
              role="region"
              aria-label={t("comparison.columns")}
              tabIndex={0}
            >
              <table
                className="w-full table-fixed text-left"
                style={{ minWidth: `${results.length * 15}rem` }}
                aria-label={t("comparison.title")}
              >
                <thead className="bg-muted/50">
                  <tr className="divide-x align-top">
                    {results.map((result) => (
                      <th
                        key={result.session.id}
                        scope="col"
                        className="px-3 py-3 font-normal"
                      >
                        {agentDetails(result)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="divide-x border-t align-top">
                    {results.map((result) => (
                      <td key={result.session.id} className="px-3 py-3">
                        {reply(result)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <table
              className="comparison-table w-full table-fixed text-left"
              aria-label={t("comparison.title")}
            >
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr role="row">
                  <th className="w-40 px-3 py-2 font-medium" scope="col">
                    Agent
                  </th>
                  <th className="px-3 py-2 font-medium" scope="col">
                    {t("comparison.reply")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr
                    key={result.session.id}
                    role="row"
                    className="border-t align-top"
                  >
                    <th
                      className="comparison-agent-cell px-3 py-3 text-left font-normal"
                      role="rowheader"
                      scope="row"
                    >
                      {agentDetails(result)}
                    </th>
                    <td className="px-3 py-3" role="cell">
                      {reply(result)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </section>
    </MessageScrollerItem>
  );
}

function ComparisonReply(props: RunResponseProps) {
  const { t } = useTranslation();
  const { run } = props;
  const { body, work, hasWorkDetails } = useRunResponse(props);
  return (
    <div className="comparison-response flex min-w-0 flex-col gap-2">
      {hasWorkDetails && work}
      {body ||
        (!hasWorkDetails && run.status === "completed" && !run.error && (
          <span className="text-sm text-muted-foreground">
            {t("comparison.noReply")}
          </span>
        ))}
      {run.error && (
        <span className="text-xs text-destructive">{run.error}</span>
      )}
    </div>
  );
}

function ComparisonAgent({
  agent,
  run,
  modelName,
}: {
  agent?: Agent;
  run: Run;
  modelName?: string;
}) {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = data?.find((item) => item.id === run.selection.provider);
  const iconOnly = run.status === "completed" || run.status === "running";
  return (
    <div className="flex min-w-0 items-center gap-2">
      {agent && <AgentAvatar agent={agent} size="sm" />}
      <div className="min-w-0">
        <p
          className={cn(
            "flex items-center gap-x-1 text-sm font-medium",
            !iconOnly && "flex-wrap",
          )}
        >
          <span className="min-w-0 break-words">
            {agent?.name ?? run.agentId}
          </span>
          <RunStatus status={run.status} iconOnly={iconOnly} />
        </p>
        <p className="text-xs break-words text-muted-foreground">
          {comparisonModelLabel(t, provider?.name ?? run.selection.provider, {
            ...run.selection,
            modelName,
          })}
        </p>
      </div>
    </div>
  );
}
