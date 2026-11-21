import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type {
  TaskExecution,
  TaskWorkflow,
  TaskWorkflowUpdate,
} from "@/api/types.gen";
import type { TaskTarget } from "./useTaskDispatch";

export function useTaskWorkflowUpdate(
  target: TaskTarget | undefined,
  queueId?: string,
) {
  return useMutation({
    mutationFn: (action: TaskWorkflowUpdate["action"]) => {
      const { id, record, noteId } = target!;
      return api(
        "/tasks/workflows/" + id,
        { record, noteId, action, queueId },
        "PATCH",
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["task-workflows"] }),
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
