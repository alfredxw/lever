import type { WorkItemPriority } from "@/api/types.gen";

export const workItemPriorities: readonly WorkItemPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
];

export function TaskPriorityIcon({
  priority,
  className,
}: {
  priority?: WorkItemPriority | "";
  className?: string;
}) {
  if (!priority) return null;
  return (
    <span
      className={`task-prio-bars ${className ?? ""}`}
      data-priority={priority}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
    </span>
  );
}
