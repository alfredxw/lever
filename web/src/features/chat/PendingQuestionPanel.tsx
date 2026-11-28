import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Request, Run } from "@/api/types.gen";
import { QuestionPrompt } from "./QuestionPrompt";
import { subagentTitle } from "./RunWork";

export function selectSessionQuestions(
  requests: Request[] | undefined,
  sessionId: string | undefined,
  sessionRuns: Run[],
): Request[] {
  if (!requests?.length) return [];
  const runIds = new Set(sessionRuns.map((run) => run.id));
  return requests.filter(
    (request) =>
      request.kind === "question" &&
      !request.delegationAgentId &&
      request.questions.length > 0 &&
      (runIds.has(request.runId) ||
        (Boolean(sessionId) && request.sessionId === sessionId)),
  );
}

export function PendingQuestionPanel({
  requests,
  runs,
  visible = true,
}: {
  requests: Request[];
  runs: Run[];
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const active = requests[0];

  const source = useMemo(() => {
    if (!active?.subagentId) return undefined;
    const run = runs.find((candidate) => candidate.id === active.runId);
    const subagent = run?.items.find(
      (item) => item.kind === "subagent" && item.id === active.subagentId,
    );
    const title = subagentTitle(subagent);
    return title
      ? t("chat.requestFromNamedSubagent", { title })
      : t("chat.requestFromSubagent");
  }, [active, runs, t]);

  if (!active) return null;

  return (
    <QuestionPrompt
      key={active.id}
      request={active}
      source={source}
      variant="docked"
      queueCount={requests.length}
      visible={visible}
    />
  );
}
