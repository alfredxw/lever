import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Overview, Reference, RemoteAgentTarget } from "@/api/types.gen";
import { displayChatTitle } from "./conversationTitle";
import { searchComposerOptions } from "./composerSearch";

const summaries = ({ agents, chats, conversations }: Overview) => ({
  agents,
  chats,
  conversations,
});

export function useMentionSources(
  enabled: boolean,
  query: string,
  sessionId?: string,
  collaboratorIds?: string[],
  remoteCollaborators?: RemoteAgentTarget[],
) {
  const { t } = useTranslation();
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
    select: summaries,
    enabled,
    subscribed: enabled,
  });
  const notes = useQuery({
    queryKey: ["task-notes", "references"],
    queryFn: ({ signal }) =>
      api<Reference[]>("/tasks/notes/references", undefined, "GET", signal),
    enabled,
    subscribed: enabled,
    retry: false,
  });
  const board = useQuery({
    queryKey: ["board-references"],
    queryFn: ({ signal }) =>
      api<Reference[]>("/tasks/board/references", undefined, "GET", signal),
    enabled,
    subscribed: enabled,
    retry: false,
  });
  const groups = useMemo(() => {
    if (!enabled) return [];
    const data = overview.data;
    const agents = new Map(data?.agents.map((agent) => [agent.id, agent.name]));
    const chats = new Map(
      data?.chats.map((chat) => [chat.id, displayChatTitle(chat, t)]),
    );
    const conversations = [...(data?.conversations ?? [])]
      .filter((session) => session.id !== sessionId)
      .sort((a, b) => b.messageAt.localeCompare(a.messageAt))
      .map((session): Reference => {
        const topic = session.kind === "topic";
        const chat = chats.get(session.chatId);
        return {
          id: session.id,
          path: "",
          kind: topic ? "topic" : "chat",
          name:
            (topic ? session.title : chat) ||
            t(topic ? "chat.topic" : "workspace.newChat"),
          description: [
            t(topic ? "chat.topic" : "workspace.chat"),
            topic && chat,
            agents.get(session.agentId),
          ]
            .filter(Boolean)
            .join(" · "),
        };
      });
    const collaborators: Reference[] = [
      ...(data?.agents ?? [])
        .filter((agent) => !agent.archived && collaboratorIds?.includes(agent.id))
        .map(
          (agent): Reference => ({
            id: agent.id,
            path: "",
            kind: "agent",
            name: agent.name,
            description: agent.profile.description || undefined,
          }),
        ),
      ...(remoteCollaborators ?? []).map(
        (target): Reference => ({
          id: target.agentId,
          deviceId: target.deviceId,
          deviceName: target.deviceName,
          path: "",
          kind: "agent",
          name: target.name,
          description: [target.deviceName, target.description]
            .filter(Boolean)
            .join(" · "),
        }),
      ),
    ];
    function group(label: string, refs: Reference[]) {
      const options = refs.map((reference) => ({
        id: `${reference.kind}:${reference.deviceId ? `${reference.deviceId}:` : ""}${reference.id}`,
        name: reference.name || t("tasks.note"),
        description:
          reference.description ||
          (reference.kind === "automationTask" ? t("automations.title") : ""),
        reference: reference.name
          ? reference
          : { ...reference, name: t("tasks.note") },
      }));
      return { label, options: searchComposerOptions(options, query) };
    }
    const noteRefs = notes.data ?? [];
    return [
      group(t("composer.conversationsGroup"), conversations),
      group(t("composer.workItemsGroup"), [
        ...(board.data ?? []),
        ...noteRefs.filter((ref) => ref.kind === "noteTask"),
      ]),
      group(
        t("composer.notesGroup"),
        noteRefs.filter((ref) => ref.kind === "note"),
      ),
      group(t("composer.collaboratorsGroup"), collaborators),
    ];
  }, [
    enabled,
    query,
    sessionId,
    collaboratorIds,
    remoteCollaborators,
    overview.data,
    board.data,
    notes.data,
    t,
  ]);
  return { groups, queries: [overview, board, notes] };
}
