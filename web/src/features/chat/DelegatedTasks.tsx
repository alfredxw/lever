import { ArrowUpRight, CircleUser } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  Agent,
  DelegatedRun,
  Request,
  RunLocation,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RequestCard } from "./RequestCard";

export type OpenRun = (
  run: RunLocation & { agentId: string },
  title: string,
) => void;

export function DelegatedTasks({
  runs,
  approvals = [],
  agents,
  onOpenRun,
}: {
  runs?: DelegatedRun[];
  approvals?: Request[];
  agents: Agent[];
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  if (!runs?.length && !approvals.length) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      role="group"
      aria-label={t("chat.delegatedTasks")}
    >
      <span className="text-xs font-medium text-muted-foreground">
        {t("chat.delegatedTasks")}
      </span>
      {runs?.map((run) => {
        const agent = agents.find((item) => item.id === run.agentId);
        return (
          <Button
            key={run.runId}
            type="button"
            variant="outline"
            className="h-auto min-h-14 w-full justify-start gap-3 bg-(--panel-background) px-3 py-2.5 text-left whitespace-normal"
            onClick={() => onOpenRun(run, run.title)}
          >
            {agent ? (
              <AgentAvatar agent={agent} />
            ) : (
              <CircleUser
                className="size-6 text-muted-foreground"
                aria-hidden
              />
            )}
            <span className="grid min-w-0 flex-1">
              <span className="font-semibold wrap-break-word">{run.title}</span>
              <span className="flex flex-wrap items-center gap-x-1.5 text-xs font-normal text-muted-foreground">
                <span className="min-w-0 wrap-break-word">
                  {agent?.name ?? t("chat.delegationAgent")}
                </span>
                <span aria-hidden>·</span>
                <span
                  data-status={run.status}
                  className="data-[status=failed]:text-destructive data-[status=waiting_user]:text-(--status-attention)"
                >
                  {t(
                    run.status === "running"
                      ? "tasks.status.running"
                      : `status.${run.status}`,
                    { defaultValue: run.status },
                  )}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-normal text-muted-foreground">
              {t("chat.openDelegation")}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </span>
          </Button>
        );
      })}
      {approvals.map((request) => (
        <RequestCard
          key={request.id}
          request={request}
          title={t("chat.approveDelegation", {
            agent:
              agents.find(({ id }) => id === request.delegationAgentId)?.name ??
              t("chat.delegationAgent"),
          })}
        />
      ))}
    </div>
  );
}
