import { ArrowUpRight, CircleUser, GitBranch, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  Agent,
  DelegatedRun,
  DelegationReceipt,
  Request,
  RunLocation,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RequestCard } from "./RequestCard";

export type OpenRun = (
  run: RunLocation & { agentId: string },
  title: string,
  options?: { sideBySide?: boolean; sourceSessionId?: string },
) => void;

function statusLabel(
  t: ReturnType<typeof useTranslation>["t"],
  status: string,
) {
  return t(
    status === "running" ? "tasks.status.running" : `status.${status}`,
    { defaultValue: status },
  );
}

export function DelegatedTasks({
  runs,
  approvals = [],
  requests = [],
  agents,
  sourceSessionId,
  onOpenRun,
}: {
  runs?: DelegatedRun[];
  approvals?: Request[];
  requests?: Request[];
  agents: Agent[];
  sourceSessionId?: string;
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
        const agentName = agent?.name ?? t("chat.delegationAgent");
        const turns = Math.max(run.turn ?? 1, run.turns ?? 1);
        const childRequests = requests.filter(
          (request) => request.runId === run.runId,
        );
        return (
          <div key={run.runId} className="flex min-w-0 flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-14 w-full items-start justify-start gap-3 bg-(--panel-background) px-3 py-2.5 text-left whitespace-normal"
              onClick={() =>
                onOpenRun(run, run.title, {
                  sideBySide: true,
                  sourceSessionId,
                })
              }
            >
              <span className="mt-0.5 shrink-0">
                {agent ? (
                  <AgentAvatar agent={agent} />
                ) : (
                  <CircleUser
                    className="size-6 text-muted-foreground"
                    aria-hidden
                  />
                )}
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold wrap-break-word">
                  {run.title}
                </span>
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-normal text-muted-foreground">
                  <span className="min-w-0 wrap-break-word">{agentName}</span>
                  <span aria-hidden>·</span>
                  <span
                    data-status={run.status}
                    className="data-[status=failed]:text-destructive data-[status=waiting_user]:text-(--status-attention)"
                  >
                    {statusLabel(t, run.status)}
                  </span>
                  {turns > 1 && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">
                        {t("chat.delegationRound", {
                          turn: run.turn ?? 1,
                          turns,
                        })}
                      </span>
                    </>
                  )}
                  {run.workingCopyName && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <GitBranch className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{run.workingCopyName}</span>
                      </span>
                    </>
                  )}
                  {run.model && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="max-w-36 truncate">{run.model}</span>
                    </>
                  )}
                </span>
                {run.summary && (
                  <span className="mt-0.5 line-clamp-2 text-xs font-normal text-muted-foreground wrap-break-word">
                    {run.summary}
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-normal text-muted-foreground">
                {t("chat.openDelegation")}
                <ArrowUpRight className="size-3.5" aria-hidden />
              </span>
            </Button>
            {childRequests.length > 0 && (
              <div className="flex min-w-0 flex-col gap-2 pl-4">
                {childRequests.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    source={t("chat.requestFromCollaborator", {
                      agent: agentName,
                    })}
                  />
                ))}
              </div>
            )}
          </div>
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

export function DelegationReceiptsBanner({
  receipts,
  agents,
  sourceSessionId,
  onOpenRun,
}: {
  receipts: DelegationReceipt[];
  agents: Agent[];
  sourceSessionId?: string;
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      role="group"
      aria-label={t("chat.delegationReceiptGroup")}
    >
      {receipts.map((receipt) => {
        const agent = agents.find((item) => item.id === receipt.agentId);
        const name =
          agent?.name ?? receipt.agentName ?? t("chat.delegationAgent");
        const title = receipt.title || name;
        return (
          <Button
            key={`${receipt.delegationId}:${receipt.runId}`}
            type="button"
            variant="outline"
            className="h-auto min-h-12 w-full items-start justify-start gap-2.5 border-dashed bg-muted/30 px-3 py-2 text-left whitespace-normal"
            onClick={() =>
              onOpenRun(
                {
                  runId: receipt.runId,
                  sessionId: receipt.sessionId,
                  chatId: receipt.chatId,
                  agentId: receipt.agentId,
                },
                title,
                { sideBySide: true, sourceSessionId },
              )
            }
          >
            <span className="mt-0.5 shrink-0">
              {agent ? (
                <AgentAvatar agent={agent} size="sm" />
              ) : (
                <Sparkles
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
              )}
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span className="font-medium text-foreground">{name}</span>
                <span className="text-muted-foreground">
                  {t("chat.delegationReceiptLabel")}
                </span>
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
                <span
                  data-status={receipt.status}
                  className="text-muted-foreground data-[status=failed]:text-destructive"
                >
                  {statusLabel(t, receipt.status)}
                </span>
                {(receipt.turn ?? 0) > 1 && (
                  <>
                    <span aria-hidden className="text-muted-foreground">
                      ·
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {t("chat.delegationTurnNumber", { turn: receipt.turn })}
                    </span>
                  </>
                )}
              </span>
              {(receipt.summary || receipt.error) && (
                <span className="line-clamp-2 text-xs font-normal text-muted-foreground wrap-break-word">
                  {receipt.summary || receipt.error}
                </span>
              )}
            </span>
            <span className="mt-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-normal text-muted-foreground">
              {t("chat.openDelegation")}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </span>
          </Button>
        );
      })}
    </div>
  );
}
