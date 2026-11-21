import { useState } from "react";
import { Command } from "cmdk";
import { UserRoundPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentAvatar } from "@/features/agents/AgentAvatar";

export function TaskNoteAgentPicker({
  agents,
  onSelect,
}: {
  agents: Agent[];
  onSelect: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t("tasks.addAgent");
  const search = t("tasks.searchAgents");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={label}
          title={label}
          onMouseDown={(event) => event.preventDefault()}
        >
          <UserRoundPlus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="task-agent-picker"
        aria-label={label}
      >
        <Command label={search} loop>
          <Command.Input asChild>
            <Input aria-label={search} placeholder={search} />
          </Command.Input>
          <Command.List>
            <Command.Empty>{t("tasks.noAgents")}</Command.Empty>
            {agents.map((agent) => (
              <Command.Item
                key={agent.id}
                value={agent.id}
                keywords={[agent.name]}
                onSelect={() => {
                  setOpen(false);
                  onSelect(agent);
                }}
              >
                <AgentAvatar agent={agent} size="sm" />
                <span className="truncate">{agent.name}</span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
