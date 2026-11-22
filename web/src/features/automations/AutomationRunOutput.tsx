import {
  ArrowUpRight,
  Code2,
  FileDiff,
  GitPullRequest,
  ListChecks,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  AutomationRun,
  UserWorkItemCreate,
  WorkItem,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import type { TaskDispatchTarget } from "@/features/tasks/useTaskDispatch";

type ReportFinding = {
  title: string;
  body: string;
  originRunId: string;
  agentId?: string;
};

export type AutomationDispatchTarget = TaskDispatchTarget | ReportFinding;
export type OpenAutomationDispatch = (target: AutomationDispatchTarget, trigger: HTMLButtonElement) => void;

export async function createFindingWorkItem(finding: ReportFinding) {
  const item = await api<WorkItem>("/tasks/work-items", {
    title: finding.title,
    body: finding.body,
    originRunId: finding.originRunId,
    assigneeAgentId: finding.agentId,
  } satisfies UserWorkItemCreate);
  void queryClient.invalidateQueries({ queryKey: ["work-items"] });
  void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
  return item;
}

export function AutomationRunOutput({
  run,
  report,
  onRead,
  onFix,
  linkedItems,
  children,
}: {
  run: AutomationRun;
  report?: boolean;
  onRead?: () => void;
  onFix: OpenAutomationDispatch;
  linkedItems: WorkItem[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const changes = run.changeSummary;
  const propose = useMutation({
    mutationFn: createFindingWorkItem,
    onSuccess: () => {
      toast.success(t("automations.convertedToWorkItem"));
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <>
      <div
        className={
          run.pullRequests?.length && changes
            ? "automation-output-bundle"
            : "contents"
        }
      >
        {run.pullRequests?.map((pr) => {
          const href = `https://github.com/${pr.repository}/pull/${pr.number}`;
          return (
            <section
              key={href}
              className="automation-artifact-box"
              aria-label={`PR #${pr.number}`}
            >
              <div className="automation-artifact-head">
                <span className="automation-artifact-title">
                  <GitPullRequest />
                  PR #{pr.number} · {pr.label || pr.repository}
                </span>
              </div>
              <div className="automation-artifact-actions">
                <code className="automation-repo-tag" title={pr.repository}>
                  {pr.repository}
                </code>
                <div className="automation-artifact-links">
                  <Button
                    asChild
                    size="xs"
                    variant="outline"
                    className="automation-btn-positive"
                  >
                    <a
                      href={`${href}/files`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Code2 />
                      {t("automations.prDiff")}
                    </a>
                  </Button>
                  <Button asChild size="xs" variant="ghost">
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      <ArrowUpRight />
                      {t("automations.openPR")}
                    </a>
                  </Button>
                </div>
              </div>
            </section>
          );
        })}
        {onRead && changes && (
          <div className="automation-artifact-box">
            <button
              type="button"
              className="automation-artifact-head automation-change-link"
              onClick={onRead}
            >
              <span className="automation-artifact-title">
                <FileDiff />
                {t("diff.fileCount", { count: changes.files })}
              </span>
              <span className="diff-stats">
                <span className="diff-added">+{changes.additions}</span>
                <span className="diff-removed">−{changes.deletions}</span>
              </span>
            </button>
          </div>
        )}
        {children}
      </div>
      {report && !!run.reportItems?.length && (
        <section className="automation-artifact-box">
          <div className="automation-artifact-head">
            <span className="automation-artifact-title">
              <ListChecks />
              {t("automations.reportExcerpt")}
            </span>
          </div>
          <ul className="automation-report-list">
            {run.reportItems.map((item, index) => {
              const finding = run.execution && {
                title: Array.from(item).slice(0, 80).join(""),
                body: item,
                agentId: run.agentId,
                originRunId: run.execution.runId,
              };
              return (
                <li key={index}>
                  <span className="automation-report-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">{item}</span>
                  {linkedItems.some((linked) => linked.body === item) ? (
                    <span className="automation-pill" data-tone="positive">
                      {t("automations.convertedToWorkItem")}
                    </span>
                  ) : (
                    finding && (
                      <div className="automation-report-actions">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={propose.isPending}
                          onClick={() => propose.mutate(finding)}
                        >
                          {t("automations.convertToWorkItem")}
                        </Button>
                        <Button
                          size="xs"
                          disabled={propose.isPending}
                          onClick={(event) => onFix(finding, event.currentTarget)}
                        >
                          {t("automations.fixFinding")}
                        </Button>
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
