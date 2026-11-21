import { createContext, useContext } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import type { Agent } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { TaskStatus } from "./taskDocument";

export const NoteAgentsContext = createContext<ReadonlyMap<
  string,
  Agent
> | null>(null);

export type AgentMentionAction = {
  caption: string;
  expanded?: boolean;
  disabled: boolean;
  status?: { value: TaskStatus; label: string };
  open: (pos: number, trigger: HTMLButtonElement) => void;
};

export function AgentMentionView({
  node,
  decorations,
  editor,
  getPos,
}: NodeViewProps) {
  const agents = useContext(NoteAgentsContext);
  const { agentId, label } = node.attrs;
  const avatar = agents?.get(agentId)?.avatar;
  const action = decorations[0]?.spec.agentAction as
    | AgentMentionAction
    | undefined;
  const agent = (
    <>
      <AgentAvatar agent={{ id: agentId, name: label, avatar }} size="sm" />
      <span className="task-agent-mention-name">{label}</span>
    </>
  );

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      data-agent-mention={agentId}
      data-agent-label={label}
    >
      {action ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="task-agent-mention"
          aria-label={action.caption}
          aria-expanded={action.expanded}
          disabled={action.disabled}
          title={action.caption}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            const pos = getPos();
            if (pos !== undefined)
              action.open(
                editor.state.doc.resolve(pos).before(),
                event.currentTarget,
              );
          }}
        >
          {agent}
          {action.status && (
            <span
              className="task-agent-mention-status"
              data-status={action.status.value}
            >
              {action.status.label}
            </span>
          )}
        </Button>
      ) : (
        <span className="task-agent-mention" title={label}>
          {agent}
        </span>
      )}
    </NodeViewWrapper>
  );
}
