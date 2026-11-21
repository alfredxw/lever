import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type { TaskView } from "@/api/types.gen";

const queryKey = ["task-views"] as const;

export function useTaskViews(visible: boolean) {
  return useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<TaskView[]>("/tasks/views", undefined, "GET", signal),
    enabled: visible,
  });
}

export async function saveTaskView(view: TaskView) {
  const saved = await api<TaskView>("/tasks/views/" + view.id, view, "PUT");
  queryClient.setQueryData<TaskView[]>(queryKey, (views = []) =>
    views.some((item) => item.id === saved.id)
      ? views.map((item) =>
          item.id === saved.id && item.revision < saved.revision ? saved : item,
        )
      : [...views, saved],
  );
  void queryClient.invalidateQueries({ queryKey });
  return saved;
}

export async function removeTaskView({ id, revision }: TaskView) {
  await api<null>("/tasks/views/" + id, { revision }, "DELETE");
  queryClient.setQueryData<TaskView[]>(queryKey, (views) =>
    views?.filter((view) => view.id !== id),
  );
  void queryClient.invalidateQueries({ queryKey });
}
