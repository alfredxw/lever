import {
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleX,
  LoaderCircle,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function isWorking(status: string) {
  return ["starting", "running", "cancelling"].includes(status);
}

export function RunStatus({
  status,
  label,
  iconOnly = false,
}: {
  status: string;
  label?: string;
  iconOnly?: boolean;
}) {
  const { t } = useTranslation();
  const working = isWorking(status);
  const Icon = working
    ? LoaderCircle
    : status === "completed"
      ? CircleCheck
      : status === "failed"
        ? CircleX
        : status === "interrupted"
          ? Square
          : status === "waiting_user"
            ? CirclePause
            : CircleHelp;
  const statusLabel = label ?? t(`status.${status}`, { defaultValue: status });
  const icon = (
    <Icon
      aria-hidden="true"
      className={cn(
        iconOnly && "size-3.5",
        working && "animate-spin motion-reduce:animate-none",
      )}
      data-icon="inline-start"
    />
  );
  if (iconOnly) {
    return (
      <span className="run-status" data-status={status} role="status">
        {icon}
        <span className="sr-only">{statusLabel}</span>
      </span>
    );
  }
  return (
    <Badge
      variant="outline"
      className="run-status"
      data-status={status}
      role="status"
    >
      {icon}
      {statusLabel}
    </Badge>
  );
}
