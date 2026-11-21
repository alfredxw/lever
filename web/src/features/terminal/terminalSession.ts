import { api } from "@/api/client";

export type SplitDirection = "right" | "down";
export type TerminalLeaf = { id: string; started?: boolean };
export type TerminalLayout =
  | TerminalLeaf
  | {
      direction: SplitDirection;
      first: TerminalLayout;
      second: TerminalLayout;
    };

export function terminalLeaves(layout: TerminalLayout): TerminalLeaf[] {
  return "id" in layout
    ? [layout]
    : [...terminalLeaves(layout.first), ...terminalLeaves(layout.second)];
}

export function terminalPath(agentId: string, sessionId?: string) {
  const path = `/agents/${encodeURIComponent(agentId)}/terminal`;
  return sessionId
    ? `${path}?sessionId=${encodeURIComponent(sessionId)}`
    : path;
}

export function closeTerminals(
  agentId: string,
  sessionId: string | undefined,
  ids: string[],
) {
  return api(terminalPath(agentId, sessionId), { ids }, "DELETE");
}
