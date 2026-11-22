import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useMutation } from "@tanstack/react-query";
import { Pause, Play, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Agent, AgentTaskQueueSettings } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { AgentQueueMetrics } from "./taskBoardModel";

const concurrencyChoices = [1, 2, 3, 4] as const;
const intervalChoices = [0, 1, 5, 15] as const;

export function TaskAgentDock({
  metrics,
  selectedAgents,
  draggingTask,
  onToggleAgentFilter,
}: {
  metrics: AgentQueueMetrics[];
  selectedAgents: string[];
  draggingTask?: boolean;
  onToggleAgentFilter: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  if (!metrics.length) return null;
  return (
    <section
      className="task-agent-dock"
      aria-label={t("tasks.agentDock")}
      data-dragging={draggingTask || undefined}
    >
      <div className="task-agent-dock-list" role="list">
        <span className="task-agent-dock-label">{t("tasks.agentDockLabel")}</span>
        {metrics.map((item) => (
          <AgentDockCapsule
            key={item.agent.id}
            metrics={item}
            selected={selectedAgents.includes(item.agent.id)}
            draggingTask={draggingTask}
            onToggleFilter={() => onToggleAgentFilter(item.agent.id)}
          />
        ))}
      </div>
    </section>
  );
}

function AgentDockCapsule({
  metrics,
  selected,
  draggingTask,
  onToggleFilter,
}: {
  metrics: AgentQueueMetrics;
  selected: boolean;
  draggingTask?: boolean;
  onToggleFilter: () => void;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    agent,
    running,
    concurrency,
    queued,
    attention,
    paused,
    intervalMinutes,
  } = metrics;
  const { setNodeRef, isOver } = useDroppable({
    id: `agent-dock:${agent.id}`,
    data: { type: "agent-dock", agentId: agent.id },
  });

  const updateQueue = useMutation({
    mutationFn: (patch: AgentTaskQueueSettings) =>
      api<Agent>(`/agents/${agent.id}/task-queue`, patch, "PATCH"),
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["task-workflows"] });
    },
  });

  const concurrencyOptions = concurrencyChoices.includes(
    concurrency as (typeof concurrencyChoices)[number],
  )
    ? [...concurrencyChoices]
    : [...concurrencyChoices, concurrency].sort((a, b) => a - b);
  const intervalOptions = intervalChoices.includes(
    intervalMinutes as (typeof intervalChoices)[number],
  )
    ? [...intervalChoices]
    : [...intervalChoices, intervalMinutes].sort((a, b) => a - b);

  const visibleSlots = Math.min(concurrency, 4);

  return (
    <div
      ref={setNodeRef}
      role="listitem"
      className="task-agent-capsule"
      data-selected={selected || undefined}
      data-paused={paused || undefined}
      data-attention={attention > 0 || undefined}
      data-drop-ready={draggingTask || undefined}
      data-drop-over={isOver || undefined}
    >
      <Button
        type="button"
        variant="ghost"
        className="task-agent-capsule-main"
        aria-pressed={selected}
        aria-label={t("tasks.agentDockFilter", { name: agent.name })}
        onClick={onToggleFilter}
      >
        <AgentAvatar agent={agent} size="sm" />
        <span className="task-agent-capsule-meta">
          <span className="task-agent-capsule-name truncate">{agent.name}</span>
          {isOver ? (
            <span className="task-agent-drop-hint">
              {t("tasks.agentDockDropHint", { name: agent.name })}
            </span>
          ) : (
            <span className="task-agent-capsule-telemetry tabular-nums">
              <span
                className="task-agent-slots"
                title={t("tasks.agentDockRunning", { running, concurrency })}
                aria-label={t("tasks.agentDockRunning", {
                  running,
                  concurrency,
                })}
              >
                <span className="task-agent-pips" aria-hidden="true">
                  {Array.from({ length: visibleSlots }, (_, index) => {
                    const isFilled = index < running;
                    const isAttentionPip = isFilled && index < attention;
                    return (
                      <span
                        key={index}
                        className="task-agent-pip"
                        data-state={
                          paused
                            ? "paused"
                            : isAttentionPip
                              ? "attention"
                              : isFilled
                                ? "filled"
                                : "empty"
                        }
                      />
                    );
                  })}
                </span>
                <span>
                  {running}/{concurrency}
                </span>
              </span>
              {queued > 0 && (
                <span
                  className="task-agent-queued-text"
                  title={t("tasks.agentDockQueued", { count: queued })}
                >
                  · {t("tasks.agentDockQueuedShort", { count: queued })}
                </span>
              )}
              {attention > 0 && (
                <span className="task-agent-attention-text">
                  · {t("tasks.agentDockApproval")}
                </span>
              )}
              {paused && (
                <span className="task-agent-paused-text">
                  · {t("tasks.queuePaused")}
                </span>
              )}
            </span>
          )}
        </span>
      </Button>
      <div className="task-agent-capsule-actions">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="task-agent-capsule-action"
          disabled={updateQueue.isPending}
          aria-label={t(paused ? "tasks.resumeQueue" : "tasks.pauseQueue", {
            name: agent.name,
          })}
          title={t(paused ? "tasks.resumeQueue" : "tasks.pauseQueue", {
            name: agent.name,
          })}
          onClick={() => updateQueue.mutate({ taskQueuePaused: !paused })}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        </Button>
        <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="task-agent-capsule-action"
              aria-label={t("tasks.queueSettings", { name: agent.name })}
              title={t("tasks.queueSettings", { name: agent.name })}
            >
              <SlidersHorizontal className="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="task-agent-settings-popover"
            aria-label={t("tasks.queueSettings", { name: agent.name })}
          >
            <div className="task-agent-settings-header">
              <AgentAvatar agent={agent} size="sm" />
              <span className="truncate font-medium">{agent.name}</span>
            </div>
            <div className="task-agent-settings-row">
              <div className="min-w-0">
                <div className="text-xs font-medium">
                  {t("tasks.autoConsume")}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("tasks.autoConsumeHint")}
                </p>
              </div>
              <Switch
                aria-label={t("tasks.autoConsume")}
                checked={!paused}
                disabled={updateQueue.isPending}
                onCheckedChange={(checked) =>
                  updateQueue.mutate({ taskQueuePaused: !checked })
                }
              />
            </div>
            <div className="task-agent-settings-group">
              <span className="text-xs font-medium">
                {t("tasks.maxConcurrency")}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                aria-label={t("tasks.maxConcurrency")}
                value={String(concurrency)}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (Number.isInteger(next) && next >= 1) {
                    updateQueue.mutate({ taskConcurrency: next });
                  }
                }}
              >
                {concurrencyOptions.map((count) => (
                  <ToggleGroupItem
                    key={count}
                    value={String(count)}
                    disabled={updateQueue.isPending}
                    className="tabular-nums"
                  >
                    {count}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="task-agent-settings-group">
              <span className="text-xs font-medium">
                {t("tasks.startInterval")}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                aria-label={t("tasks.startInterval")}
                value={String(intervalMinutes)}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (Number.isInteger(next) && next >= 0) {
                    updateQueue.mutate({ taskStartIntervalMinutes: next });
                  }
                }}
              >
                {intervalOptions.map((minutes) => (
                  <ToggleGroupItem
                    key={minutes}
                    value={String(minutes)}
                    disabled={updateQueue.isPending}
                    className="tabular-nums"
                  >
                    {minutes === 0
                      ? t("tasks.intervalNone")
                      : t("tasks.intervalMinutes", { count: minutes })}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
