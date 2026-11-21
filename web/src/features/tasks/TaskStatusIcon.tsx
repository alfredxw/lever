import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleX,
  ListOrdered,
} from "lucide-react";
import type { TaskStatus } from "./taskDocument";

const icons = {
  todo: Circle,
  unconfirmed: CircleHelp,
  queued: ListOrdered,
  running: CircleDashed,
  attention: CircleAlert,
  review: CircleDot,
  done: CircleCheck,
  closed: CircleX,
} satisfies Record<TaskStatus, typeof Circle>;

export const taskStatuses = Object.keys(icons) as TaskStatus[];

export function TaskStatusIcon({ status }: { status: TaskStatus }) {
  const Icon = icons[status];
  return (
    <Icon
      className="task-status-icon size-3.5 shrink-0"
      data-status={status}
      aria-hidden="true"
    />
  );
}
