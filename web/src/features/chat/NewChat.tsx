import { useState } from "react";
import { useRemoteBindings } from "@/features/settings/RemoteDevices";
import { Switch } from "@/components/ui/switch";
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
  const bindings = useRemoteBindings();
  const scopes =
    bindings.data?.filter(
      (b) =>
        b.role !== "controller" && (b.exposeAll || b.agents.includes(agent.id)),
    ) ?? [];
  const [scopeKey, setScope] = useState("");
  const scope = scopes.find((b) => b.hubId + "/" + b.spaceId === scopeKey);
  return (
    <div className="chat-composer-wrap">
      {scopes.length > 0 && (
        <div className="flex items-center gap-2 px-3 text-xs">
          <label className="flex items-center gap-2">
            <Switch
              aria-label="共享到空间"
              checked={!!scope}
              onCheckedChange={(on) =>
                setScope(on ? scopes[0].hubId + "/" + scopes[0].spaceId : "")
              }
            />
            共享到空间
          </label>
          {!!scope && scopes.length > 1 && (
            <select value={scopeKey} onChange={(e) => setScope(e.target.value)}>
              {scopes.map((b) => (
                <option
                  key={b.hubId + b.spaceId}
                  value={b.hubId + "/" + b.spaceId}
                >
                  {b.origin} · {b.spaceId}
                </option>
              ))}
            </select>
          )}
          {scope && <span>对话和审批正文将同步到 Hub</span>}
        </div>
      )}
      <Composer
        agentId={agent.id}
        agents={agents}
        chatId={draftChatId(agent.id)}
        autoFocus={autoFocus}
        visible={visible}
        draftAgentId={agent.id}
        sharedScope={scope && { hubId: scope.hubId, spaceId: scope.spaceId }}
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
