import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus, X } from "lucide-react";
import {
  MaxComparisonAgents,
  type ProviderInfo,
  type Selection,
} from "@/api/types.gen";
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
import { ModelPicker } from "./ModelPicker";
import type { useComparisonModels } from "./useComparisonModels";

export function ComparisonPicker({
  participants,
  selected,
  disabled,
  providers,
  onModelChange,
  onReturnToComposer,
  onChange,
}: {
  participants: ReturnType<typeof useComparisonModels>;
  selected: string[];
  disabled: boolean;
  providers?: ProviderInfo[];
  onModelChange: (id: string, value: Selection) => void;
  onReturnToComposer: () => void;
  onChange: (agents: string[]) => void;
}) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<string | null>("agents");
  function togglePanel(id: string, open: boolean) {
    setPanel((current) => (open ? id : current === id ? null : current));
  }
  const id = useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {selected.map((agentId) => {
        const participant = participants.find(
          (item) => item.agent.id === agentId,
        );
        const agent = participant?.agent;
        const name = agent?.name ?? agentId;
        const modelPanel = `model:${agentId}`;
        const label = t("comparison.chooseModel", { name });
        const trigger = (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-6 min-w-0 shrink gap-1.5 rounded-full py-0.5 pl-1 pr-1.5 text-left"
            aria-label={label}
            title={[label, participant?.label].filter(Boolean).join("\n")}
            disabled={disabled || !participant?.catalog || agent?.archived}
          >
            {agent && <AgentAvatar agent={agent} size="sm" />}
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 whitespace-normal">
              <span className="max-w-full truncate">{name}</span>
              <span className="min-w-0 text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
                {participant?.label}
              </span>
            </span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        );
        return (
          <Badge
            key={agentId}
            variant="secondary"
            className="h-auto max-w-full gap-0 rounded-full bg-clip-padding p-0.5"
          >
            {participant?.catalog ? (
              <ModelPicker
                trigger={trigger}
                label={label}
                providers={providers}
                catalog={participant.catalog}
                value={participant.choice}
                cwd={participant.cwd}
                open={panel === modelPanel && !disabled}
                onOpenChange={(open) => togglePanel(modelPanel, open)}
                onReturnToComposer={onReturnToComposer}
                onChange={(value) => onModelChange(agentId, value)}
                selectionForProvider={participant.selectionForProvider}
                disabled={disabled || agent?.archived}
              />
            ) : (
              trigger
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              aria-label={t("comparison.removeAgent", { name })}
              disabled={disabled}
              onClick={() =>
                onChange(selected.filter((item) => item !== agentId))
              }
            >
              <X />
            </Button>
          </Badge>
        );
      })}
      <Popover
        open={panel === "agents" && !disabled}
        onOpenChange={(open) => togglePanel("agents", open)}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={disabled}
          >
            <Plus data-icon="inline-start" />
            {t("comparison.addAgents")}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-72 max-w-[calc(100vw-24px)] p-2"
          aria-label={t("comparison.agents")}
        >
          <FieldSet>
            <FieldLegend className="px-2" variant="label">
              {t("comparison.agents")}
            </FieldLegend>
            <FieldGroup className="max-h-56 gap-0.5 overflow-y-auto px-2 pb-1">
              {participants
                .filter(
                  ({ agent }) => !agent.archived || selected.includes(agent.id),
                )
                .map(({ agent, available, label }) => {
                  const checked = selected.includes(agent.id);
                  const unavailable =
                    !checked &&
                    (!available || selected.length >= MaxComparisonAgents);
                  const fieldId = `${id}-${agent.id}`;
                  return (
                    <Field
                      key={agent.id}
                      orientation="horizontal"
                      data-disabled={unavailable || undefined}
                      className="min-h-9 gap-3"
                    >
                      <Checkbox
                        id={fieldId}
                        checked={checked}
                        disabled={unavailable}
                        onCheckedChange={(value) =>
                          onChange(
                            value
                              ? [...selected, agent.id]
                              : selected.filter((item) => item !== agent.id),
                          )
                        }
                      />
                      <FieldLabel
                        htmlFor={fieldId}
                        className="min-w-0 gap-2 py-1"
                      >
                        <AgentAvatar agent={agent} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate">{agent.name}</span>
                          <span className="block text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
                            {label}
                          </span>
                        </span>
                      </FieldLabel>
                    </Field>
                  );
                })}
            </FieldGroup>
          </FieldSet>
        </PopoverContent>
      </Popover>
    </div>
  );
}
