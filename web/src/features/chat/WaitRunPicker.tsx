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
import {
  dependencyProgress,
  isDependencyBlocked,
  isRunWaiting,
  type WaitableRun,
} from "./waitRuns";

export function DependencyStatusIcon({
  status,
  blocked,
  className,
}: {
  status: string;
  blocked?: boolean;
  className?: string;
}) {
  const working = isWorking(status);
  const depBlocked = isDependencyBlocked(status, blocked);
  const Icon = working
    ? LoaderCircle
    : status === "completed"
      ? CircleCheck
      : status === "waiting_user" || status === "paused"
        ? CirclePause
        : depBlocked
          ? CircleX
          : status === "queued"
            ? Clock
            : CircleHelp;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "size-3 shrink-0",
        working && "animate-spin motion-reduce:animate-none text-(--status-positive)",
        status === "completed" && "text-(--status-positive)",
        status === "waiting_user" && "text-(--status-attention)",
        depBlocked && "text-destructive",
        !depBlocked && status === "queued" && "text-muted-foreground",
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
  resolved: Map<
    string,
    Pick<RunDependency, "runId" | "title" | "status" | "blocked">
  >;
  disabled: boolean;
  initialOpen?: boolean;
  onChange: (runIds: string[]) => void;
  onReturnToComposer?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialOpen);
  const id = useId();

  const candidateById = new Map(candidates.map((item) => [item.run.id, item]));
  const selectedSet = new Set(selected);
  const selectedCandidateCount = candidates.filter((item) =>
    selectedSet.has(item.run.id),
  ).length;
  const allSelected =
    candidates.length > 0 && selectedCandidateCount === candidates.length;
  const sameScope = candidates.filter((item) => item.sameScope);
  const otherScope = candidates.filter((item) => !item.sameScope);

  function toggle(runId: string, checked: boolean) {
    if (checked) {
      if (!selectedSet.has(runId)) onChange([...selected, runId]);
    } else {
      onChange(selected.filter((item) => item !== runId));
    }
  }

  function toggleAll() {
    if (allSelected) {
      onChange([]);
      return;
    }
    const next = [...selected];
    for (const item of candidates) {
      if (!selectedSet.has(item.run.id)) next.push(item.run.id);
    }
    onChange(next.slice(0, 50));
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
            const checked = selectedSet.has(item.run.id);
            const fieldId = `${id}-${item.run.id}`;
            const progress = isRunWaiting(item.run)
              ? dependencyProgress(item.run.waitingOn)
              : undefined;
            const statusText = progress
              ? t("after.waitingProgressShort", {
                  completed: progress.completed,
                  total: progress.total,
                })
              : t(`status.${item.run.status}`, {
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
      className="flex h-6 w-full min-w-0 items-center gap-1.5"
      aria-label={t("after.title")}
    >
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {t("after.waitingLabel")}
      </span>
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
            className="h-6 shrink-0 rounded-full px-2 text-xs"
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
            <div className="flex flex-col">
              <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-border/60 px-2 pb-1.5">
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  {t("after.selectedCount", {
                    selected: selectedCandidateCount,
                    total: candidates.length,
                  })}
                </span>
                <div className="flex items-center gap-0.5">
                  {!allSelected && selected.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                      disabled={disabled}
                      onClick={() => onChange([])}
                    >
                      {t("after.clearSelected")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                    disabled={disabled}
                    onClick={toggleAll}
                  >
                    {t(allSelected ? "after.clearAll" : "after.selectAll")}
                  </Button>
                </div>
              </div>
              <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                {renderGroup(t("after.sameDirectory"), sameScope)}
                {renderGroup(t("after.otherTasks"), otherScope)}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onWheel={(event) => {
            const el = event.currentTarget;
            if (
              el.scrollWidth > el.clientWidth &&
              Math.abs(event.deltaY) > Math.abs(event.deltaX)
            ) {
              event.preventDefault();
              el.scrollLeft += event.deltaY;
            }
          }}
        >
          {selected.map((runId) => {
            const candidate = candidateById.get(runId);
            const info = resolved.get(runId);
            const title = candidate?.title || info?.title || runId.slice(0, 8);
            const status = candidate?.run.status || info?.status || "unknown";
            const blocked = isDependencyBlocked(status, info?.blocked);
            const progress =
              candidate && isRunWaiting(candidate.run)
                ? dependencyProgress(candidate.run.waitingOn)
                : undefined;
            const statusText =
              blocked && status === "queued"
                ? t("after.statusBlocked")
                : progress
                  ? t("after.waitingProgressShort", {
                      completed: progress.completed,
                      total: progress.total,
                    })
                  : t(`status.${status}`, { defaultValue: status });
            return (
              <Badge
                key={runId}
                variant="secondary"
                data-status={status}
                className={cn(
                  "h-6 shrink-0 gap-1 rounded-full bg-clip-padding py-0 pl-2 pr-0.5",
                  blocked && "border-destructive/40 text-destructive",
                )}
                title={[title, statusText].filter(Boolean).join(" · ")}
              >
                <DependencyStatusIcon status={status} blocked={blocked} />
                <span className="max-w-44 truncate text-xs font-normal">
                  {title}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 rounded-full"
                  aria-label={t("after.removeTask", { title })}
                  disabled={disabled}
                  onClick={() => toggle(runId, false)}
                >
                  <X />
                </Button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
