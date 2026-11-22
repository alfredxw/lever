import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleX,
  Clock,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import type { RunDependency } from "@/api/types.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { cn } from "@/lib/utils";
import { isWorking } from "./RunStatus";
import { isDependencyBlocked, type WaitableRun } from "./waitRuns";

export function DependencyStatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const working = isWorking(status);
  const Icon = working
    ? LoaderCircle
    : status === "completed"
      ? CircleCheck
      : status === "queued"
        ? Clock
        : status === "waiting_user" || status === "paused"
          ? CirclePause
          : isDependencyBlocked(status)
            ? CircleX
            : CircleHelp;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "size-3 shrink-0",
        working && "animate-spin motion-reduce:animate-none text-(--status-positive)",
        status === "completed" && "text-(--status-positive)",
        status === "waiting_user" && "text-(--status-attention)",
        isDependencyBlocked(status) && "text-destructive",
        status === "queued" && "text-muted-foreground",
        className,
      )}
    />
  );
}

export function WaitRunPicker({
  candidates,
  selected,
  resolved,
  disabled,
  initialOpen = false,
  onChange,
  onReturnToComposer,
}: {
  candidates: WaitableRun[];
  selected: string[];
  resolved: Map<string, Pick<RunDependency, "runId" | "title" | "status">>;
  disabled: boolean;
  initialOpen?: boolean;
  onChange: (runIds: string[]) => void;
  onReturnToComposer?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialOpen);
  const id = useId();

  const candidateById = new Map(candidates.map((item) => [item.run.id, item]));
  const sameScope = candidates.filter((item) => item.sameScope);
  const otherScope = candidates.filter((item) => !item.sameScope);

  function toggle(runId: string, checked: boolean) {
    if (checked) {
      if (!selected.includes(runId)) onChange([...selected, runId]);
    } else {
      onChange(selected.filter((item) => item !== runId));
    }
  }

  function renderGroup(label: string, items: WaitableRun[]) {
    if (!items.length) return null;
    return (
      <FieldSet className="gap-1">
        <FieldLegend className="px-2 text-xs text-muted-foreground" variant="label">
          {label}
        </FieldLegend>
        <FieldGroup className="gap-0.5 px-2 pb-1">
          {items.map((item) => {
            const checked = selected.includes(item.run.id);
            const fieldId = `${id}-${item.run.id}`;
            const statusText = t(`status.${item.run.status}`, {
              defaultValue: item.run.status,
            });
            const meta = [
              item.agent?.name,
              item.directoryLabel,
              statusText,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Field
                key={item.run.id}
                orientation="horizontal"
                className="min-h-9 shrink-0 gap-2.5"
              >
                <Checkbox
                  id={fieldId}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(value) => toggle(item.run.id, value === true)}
                />
                <FieldLabel
                  htmlFor={fieldId}
                  className="min-w-0 flex-1 cursor-pointer gap-2 py-1"
                >
                  {item.agent && <AgentAvatar agent={item.agent} size="sm" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <DependencyStatusIcon status={item.run.status} />
                      <span className="truncate" title={item.title}>
                        {item.title}
                      </span>
                    </span>
                    {meta && (
                      <span className="block truncate text-xs font-normal text-muted-foreground">
                        {meta}
                      </span>
                    )}
                  </span>
                </FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>
    );
  }

  return (
    <div
      role="group"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      aria-label={t("after.title")}
    >
      <span className="text-xs font-medium text-muted-foreground">
        {t("after.waitingLabel")}
      </span>
      {selected.map((runId) => {
        const candidate = candidateById.get(runId);
        const info = resolved.get(runId);
        const title = candidate?.title || info?.title || runId.slice(0, 8);
        const status = candidate?.run.status || info?.status || "unknown";
        const blocked = isDependencyBlocked(status);
        const statusText = t(`status.${status}`, { defaultValue: status });
        return (
          <Badge
            key={runId}
            variant="secondary"
            data-status={status}
            className={cn(
              "h-auto max-w-full gap-1 rounded-full bg-clip-padding py-0.5 pl-2 pr-0.5",
              blocked && "border-destructive/40 text-destructive",
            )}
            title={[title, statusText].filter(Boolean).join(" · ")}
          >
            <DependencyStatusIcon status={status} />
            <span className="max-w-44 truncate text-xs font-normal">
              {title}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              aria-label={t("after.removeTask", { title })}
              disabled={disabled}
              onClick={() => toggle(runId, false)}
            >
              <X />
            </Button>
          </Badge>
        );
      })}
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onReturnToComposer?.();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-6 rounded-full px-2 text-xs"
            disabled={disabled}
          >
            <Plus data-icon="inline-start" />
            {t("after.addTasks")}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 max-w-[calc(100vw-24px)] p-2"
          aria-label={t("after.tasks")}
        >
          {candidates.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("after.noRunningTasks")}
            </p>
          ) : (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {renderGroup(t("after.sameDirectory"), sameScope)}
              {renderGroup(t("after.otherTasks"), otherScope)}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
