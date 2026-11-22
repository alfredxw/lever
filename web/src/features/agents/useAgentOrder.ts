import { createContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { arrayMove } from "@dnd-kit/sortable";
import type { Agent } from "@/api/types.gen";
import type { WorkbenchOverview } from "@/components/workbench/workbenchOverview";

export type AgentSort = "recent" | "name" | "manual";

const noAgents: Agent[] = [];
export const AgentOrderContext = createContext<readonly Agent[]>(noAgents);

function readOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem("lever:agent-order") ?? "[]",
    );
    return Array.isArray(saved)
      ? saved.filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function useAgentOrder(activity?: WorkbenchOverview) {
  const { i18n } = useTranslation();
  const { agents = noAgents, chats, conversations } = activity ?? {};
  const [sort, setSort] = useState<AgentSort>(() => {
    const saved = localStorage.getItem("lever:agent-sort");
    return saved === "name" || saved === "manual" ? saved : "recent";
  });
  const [manualOrder, setManualOrder] = useState(readOrder);
  useEffect(() => localStorage.setItem("lever:agent-sort", sort), [sort]);
  useEffect(
    () =>
      localStorage.setItem("lever:agent-order", JSON.stringify(manualOrder)),
    [manualOrder],
  );

  const manualAgents = useMemo(() => {
    const positions = new Map(manualOrder.map((id, index) => [id, index]));
    const position = (id: string) => positions.get(id) ?? manualOrder.length;
    return [...agents].sort(
      (left, right) =>
        position(left.id) - position(right.id) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }, [agents, manualOrder]);

  const orderedAgents = useMemo(() => {
    if (sort === "manual") return manualAgents;

    const recency = new Map<string, number>();
    if (sort === "recent") {
      function record(id: string, at: string) {
        recency.set(
          id,
          Math.max(recency.get(id) ?? -Infinity, Date.parse(at) || 0),
        );
      }
      for (const agent of agents) record(agent.id, agent.createdAt);
      for (const chat of chats ?? []) record(chat.agentId, chat.updatedAt);
      for (const item of conversations ?? [])
        record(item.agentId, item.messageAt);
    }
    const collator = new Intl.Collator(i18n.language, {
      numeric: true,
      sensitivity: "base",
    });
    return [...agents].sort(
      (left, right) =>
        (recency.get(right.id) ?? 0) - (recency.get(left.id) ?? 0) ||
        collator.compare(left.name, right.name),
    );
  }, [agents, chats, conversations, i18n.language, manualAgents, sort]);

  function moveAgent(id: string, overId: string) {
    if (id === overId) return;
    const base = (
      sort === "manual"
        ? manualAgents
        : [
            ...orderedAgents.filter((agent) => !agent.archived),
            ...manualAgents.filter((agent) => agent.archived),
          ]
    ).map((agent) => agent.id);
    const from = base.indexOf(id);
    const to = base.indexOf(overId);
    if (from < 0 || to < 0) return;
    setManualOrder(arrayMove(base, from, to));
    setSort("manual");
  }

  return { agents: orderedAgents, sort, setSort, moveAgent };
}
