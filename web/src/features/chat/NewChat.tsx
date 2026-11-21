import { useTranslation } from "react-i18next";
import type { Agent } from "@/api/types.gen";
import { Composer } from "./Composer";
import { ImagePreview, ImagePreviewProvider } from "./ImagePreview";

type NewChatProps = {
  agent: Agent;
  agents: Agent[];
  visible: boolean;
  onSent: (chatId: string) => void;
};

export const draftChatId = (agentId: string) => `draft:${agentId}`;

export function NewChatComposer({
  agent,
  agents,
  visible,
  autoFocus,
  onSent,
}: NewChatProps & { autoFocus?: boolean }) {
  return (
    <div className="chat-composer-wrap">
      <Composer
        agentId={agent.id}
        agents={agents}
        chatId={draftChatId(agent.id)}
        autoFocus={autoFocus}
        visible={visible}
        draftAgentId={agent.id}
        profile={agent.profile}
        archived={agent.archived}
        onSent={({ chatId }) => onSent(chatId)}
      />
    </div>
  );
}

export function NewChat(props: NewChatProps) {
  const { t } = useTranslation();
  return (
    <ImagePreviewProvider>
      <div className="chat-panel new-chat-panel">
        <div className="new-chat-input">
          <h2>{t("chat.welcome", { name: props.agent.name })}</h2>
          <NewChatComposer {...props} autoFocus />
        </div>
        <ImagePreview />
      </div>
    </ImagePreviewProvider>
  );
}
