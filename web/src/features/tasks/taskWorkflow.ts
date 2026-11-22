import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type {
  TaskExecution,
  TaskWorkflow,
  TaskWorkflowUpdate,
} from "@/api/types.gen";
import type { TaskTarget } from "./useTaskDispatch";

export async function changeTaskWorkflow(
  target: TaskTarget,
  action: TaskWorkflowUpdate["action"],
  queueId?: string,
) {
  await api(
    "/tasks/workflows/" + target.id,
    { record: target.record, noteId: target.noteId, action, queueId },
    "PATCH",
  );
  await Promise.all(
    [
      ["task-workflows"],
      ["task-executions"],
      ...(action === "todo" || action === "delete"
        ? [["work-items"], ["external-tasks"], ["automation-runs"]]
        : []),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

export function useTaskWorkflowUpdate(
  target: TaskTarget | undefined,
  queueId?: string,
) {
  return useMutation({
    mutationFn: (action: TaskWorkflowUpdate["action"]) =>
      changeTaskWorkflow(target!, action, queueId),
  });
}

export function useTaskActivity(visible: boolean) {
  const runQuery = useQuery({
    queryKey: ["task-executions"],
    queryFn: ({ signal }) =>
      api<TaskExecution[]>("/tasks/executions", undefined, "GET", signal),
    enabled: visible,
    refetchOnWindowFocus: true,
  });
  const executions = useMemo(
    () => new Map(runQuery.data?.map((run) => [run.taskId, run])),
    [runQuery.data],
  );
  const workflowQuery = useQuery({
    queryKey: ["task-workflows"],
    queryFn: ({ signal }) =>
      api<TaskWorkflow[]>("/tasks/workflows", undefined, "GET", signal),
    enabled: visible,
    refetchOnWindowFocus: true,
  });
  const workflows = useMemo(
    () => new Map(workflowQuery.data?.map((item) => [item.taskId, item])),
    [workflowQuery.data],
  );
  return { runQuery, workflowQuery, executions, workflows };
}
