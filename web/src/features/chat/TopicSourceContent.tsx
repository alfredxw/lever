import { useTranslation } from "react-i18next";
import type { Agent, Session, TopicSource } from "@/api/types.gen";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { ChatResponse, type OpenChatFile } from "./ChatResponse";
import { stripCitationMarkers } from "./chatCitations";
import { MessageActions, type MessageActionHandlers } from "./MessageActions";
import { UserMessage } from "./UserMessage";

export function TopicSourceContent({
  source,
  session,
  agent,
  onOpenFile,
  onQuote,
  onForward,
}: MessageActionHandlers & {
  source: TopicSource;
  session: Session;
  agent: Agent;
  onOpenFile: OpenChatFile;
}) {
  const { t } = useTranslation();
  const { message, items } = source;
  const output = items
    .filter((item) => item.kind === "text")
    .map((item) => stripCitationMarkers(item.text))
    .join("\n\n");
  const userMessage = (entry: TopicSource["message"]) => (
    <UserMessage
      key={entry.id}
      sessionId={session.id}
      message={entry}
      archived={agent.archived}
      onQuote={onQuote}
      onForward={onForward}
    />
  );
  return (
    <MessageScrollerItem
      className="run-content"
      role="group"
      aria-label={t("chat.topicSource")}
    >
      {userMessage(message)}
      {items.length > 0 && (
        <Message className="agent-message" aria-label={agent.name}>
          <MessageContent className="gap-4">
            <MessageHeader className="agent-author gap-2 px-0">
              <AgentAvatar agent={agent} size="sm" />
              <span className="truncate">{agent.name}</span>
            </MessageHeader>
            <div className="message-body">
              {items.map((item) =>
                item.message ? (
                  userMessage(item.message)
                ) : (
                  <ChatResponse
                    key={item.id}
                    runId={message.id}
                    text={item.text}
                    citations={item.citations}
                    running={false}
                    session={session}
                    onOpenFile={onOpenFile}
                  />
                ),
              )}
            </div>
            <MessageActions
              message={{
                runId: message.id,
                role: "assistant",
                author: agent.name,
                text: output,
              }}
              timestamp={source.finishedAt}
              disabled={agent.archived}
              onQuote={onQuote}
              onForward={onForward}
            />
          </MessageContent>
        </Message>
      )}
    </MessageScrollerItem>
  );
}
