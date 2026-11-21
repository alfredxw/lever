import { useTranslation } from "react-i18next";
import type { Agent } from "@/api/types.gen";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { AgentAvatar } from "@/features/agents/AgentAvatar";

export function TaskAgentSelect({
  agents,
  value,
  onChange,
  id,
  label,
  className,
  disabled,
  capsule,
}: {
  agents: Agent[];
  value?: string;
  onChange: (value: string) => void;
  id?: string;
  label: string;
  className?: string;
  disabled?: boolean;
  capsule?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SearchableSelect
      id={id}
      label={label}
      placeholder={t("tasks.selectAgent")}
      searchLabel={t("tasks.searchAgents")}
      emptyLabel={t("tasks.noAgents")}
      options={agents.map((agent) => ({
        id: agent.id,
        label: agent.name,
        icon: <AgentAvatar agent={agent} size="sm" />,
      }))}
      value={value}
      onChange={onChange}
      disabled={disabled || !agents.length}
      align={capsule ? "start" : undefined}
      className={capsule ? "w-fit max-w-full rounded-full" : className}
    />
  );
}
