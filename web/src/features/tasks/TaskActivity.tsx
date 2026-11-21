import { useId } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { active, api } from "@/api/client";
import type { Agent, Run, TaskExecution } from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice, Loading } from "@/components/common";
import { ActivityTime } from "@/components/workbench/ActivityTime";
import { RunStatus } from "@/features/chat/RunStatus";
import { DelegatedTasks, type OpenRun } from "@/features/chat/DelegatedTasks";
import {
  chatDelegationsQuery,
  sessionRunsQuery,
} from "@/features/chat/queries";
import { TaskAssignee } from "./TaskAssignee";

export function TaskActivity({
  execution,
  agent,
  agents,
  onOpenRun,
}: {
  execution?: TaskExecution;
  agent?: Agent;
  agents: Agent[];
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  const heading = useId();
  return (
    <section className="task-activity" aria-labelledby={heading}>
      <h3 id={heading}>{t("tasks.activity")}</h3>
      {execution ? (
        <LinkedTaskActivity
          execution={execution}
          agent={agent}
          agents={agents}
          onOpenRun={onOpenRun}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("tasks.noActivity")}</p>
      )}
    </section>
  );
}

function runTime(run?: Run) {
  return run?.finishedAt || run?.startedAt || run?.createdAt;
}

function LinkedTaskActivity({
  execution,
  agent,
  agents,
  onOpenRun,
}: {
  execution: TaskExecution;
  agent?: Agent;
  agents: Agent[];
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  const automated = !!execution.automationId;
  const history = useInfiniteQuery({
    ...sessionRunsQuery(execution.sessionId),
    enabled: !automated,
  });
  const exactRun = useQuery({
    queryKey: ["run", execution.runId],
    queryFn: ({ signal }) =>
      api<Run>("/runs/" + execution.runId, undefined, "GET", signal),
    enabled: automated,
  });
  const query = automated ? exactRun : history;
  const runs =
    history.data?.pages[0]?.runs.filter(
      (run) => !run.superseded && !run.automationId,
    ) ?? [];
  const current = automated
    ? exactRun.data
    : runs.find((run) => run.id === execution.runId);
  const earlier = automated
    ? []
    : runs.filter((run) => run.id !== execution.runId).slice(0, 2);
  const output = current?.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("\n\n");
  const labelFor = (status: string) =>
    status === "completed" ? t("tasks.executionCompleted") : undefined;
  return (
    <>
      <ol className="task-activity-list">
        {!!execution.status && (
          <li className="task-activity-run">
            <div className="task-activity-row">
              <TaskAssignee agent={agent} assigned />
              <ActivityTime
                timestamp={runTime(current) || execution.activityAt}
              />
            </div>
            <RunStatus
              status={execution.status}
              label={labelFor(execution.status)}
            />
            {current?.error && <ErrorNotice error={current.error} />}
            {output ? (
              <MessageResponse
                text={output}
                running={active(execution.status)}
              />
            ) : current &&
              !current.error &&
              execution.status === "completed" ? (
              <p className="text-sm text-muted-foreground">
                {t("tasks.noResult")}
              </p>
            ) : null}
            <TaskDelegations
              execution={execution}
              agents={agents}
              onOpenRun={onOpenRun}
            />
          </li>
        )}
        {earlier.map((run) => (
          <li className="task-activity-row task-activity-event" key={run.id}>
            <RunStatus status={run.status} label={labelFor(run.status)} />
            <ActivityTime timestamp={runTime(run)} />
          </li>
        ))}
        <li className="task-activity-row task-activity-event">
          <span className="task-activity-dispatch">
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="shrink-0">{t("tasks.activityDispatched")}</span>
            <TaskAssignee agent={agent} assigned />
          </span>
          <ActivityTime timestamp={execution.dispatchedAt} />
        </li>
      </ol>
      {query.isPending && <Loading />}
      {query.isError && (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      )}
    </>
  );
}

export function TaskDelegations({
  execution,
  agents,
  onOpenRun,
}: {
  execution: TaskExecution;
  agents: Agent[];
  onOpenRun: OpenRun;
}) {
  const { data } = useQuery(chatDelegationsQuery(execution.chatId));
  return (
    <DelegatedTasks
      runs={data?.outgoing[execution.runId]}
      agents={agents}
      onOpenRun={onOpenRun}
    />
  );
}
