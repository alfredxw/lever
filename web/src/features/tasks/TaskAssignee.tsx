import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent } from "@/api/types.gen";
import { AgentAvatar } from "@/features/agents/AgentAvatar";

export function TaskAssignee({
  agent,
  assigned,
}: {
  agent?: Agent;
  assigned?: boolean;
}) {
  const { t } = useTranslation();
  const name =
    agent?.name ?? t(assigned ? "tasks.unavailableAgent" : "tasks.unassigned");
  return (
    <span className="task-assignee" data-known={!!agent}>
      {agent ? (
        <AgentAvatar agent={agent} size="sm" />
      ) : (
        <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate" title={name}>
        {name}
      </span>
    </span>
  );
}
