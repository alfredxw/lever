import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import type { Agent, Chat, NoteHandover, TaskNote } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { useAutoSave } from "@/hooks/useAutoSave";
import { NoteHandoverSheet } from "./NoteHandoverSheet";
import { TaskAgentSelect } from "./TaskAgentSelect";
import { noteHandoverQuery } from "./useTaskDispatch";

type SettingsProps = {
  note: TaskNote;
  agents: Agent[];
  chats: Chat[];
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
};

function handoverSignature(settings: NoteHandover) {
  return JSON.stringify([
    settings.agentId ?? "",
    settings.chatId ?? "",
    !!settings.oneClick,
  ]);
}

export function NoteHandoverSettings(props: SettingsProps) {
  const { t } = useTranslation();
  const query = useQuery(noteHandoverQuery(props.note.id));
  return (
    <NoteHandoverSheet
      title={t("tasks.handoverSettings")}
      onClose={props.onClose}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      {query.data ? (
        <SettingsForm
          key={props.note.id}
          noteId={props.note.id}
          agents={props.agents}
          chats={props.chats}
          initial={query.data}
        />
      ) : (
        <div className="task-handover-body">
          {query.error ? (
            <ErrorNotice
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : (
            <Skeleton className="h-20" />
          )}
        </div>
      )}
    </NoteHandoverSheet>
  );
}

function SettingsForm({
  noteId,
  agents,
  chats,
  initial,
}: Pick<SettingsProps, "agents" | "chats"> & {
  noteId: string;
  initial: NoteHandover;
}) {
  const { t } = useTranslation();
  const [agentId, setAgent] = useState(initial.agentId ?? "");
  const [chatId, setChat] = useState(initial.chatId ?? "");
  const [mode, setMode] = useState(initial.chatId ? "existing" : "dedicated");
  const [oneClick, setOneClick] = useState(initial.oneClick ?? false);
  const oneClickId = useId();
  const initialSig = handoverSignature(initial);
  const prevInitialSig = useRef(initialSig);
  const pendingOwnEchoes = useRef<string[]>([]);

  const autoSave = useAutoSave<NoteHandover, NoteHandover>({
    initialSignature: initialSig,
    save: (settings) =>
      api<NoteHandover>(`/tasks/notes/${noteId}/handover`, settings, "PUT"),
    onSaved: (settings) => {
      const sig = handoverSignature(settings);
      if (sig !== prevInitialSig.current) pendingOwnEchoes.current.push(sig);
      queryClient.setQueryData(noteHandoverQuery(noteId).queryKey, settings);
    },
  });

  useEffect(() => {
    if (initialSig === prevInitialSig.current) return;
    prevInitialSig.current = initialSig;
    const echoIndex = pendingOwnEchoes.current.indexOf(initialSig);
    if (echoIndex !== -1) {
      pendingOwnEchoes.current.splice(0, echoIndex + 1);
      return;
    }
    pendingOwnEchoes.current = [];
    autoSave.syncSaved(initialSig);
    if (!autoSave.saving && !autoSave.pending && !autoSave.error) {
      setAgent(initial.agentId ?? "");
      setChat(initial.chatId ?? "");
      setMode(initial.chatId ? "existing" : "dedicated");
      setOneClick(initial.oneClick ?? false);
    }
  }, [
    initial.agentId,
    initial.chatId,
    initial.oneClick,
    initialSig,
    autoSave.saving,
    autoSave.pending,
    autoSave.error,
    autoSave.syncSaved,
  ]);

  const agent = agents.find((item) => item.id === agentId);
  const ownedChats = chats.filter(
    (item) => item.agentId === agent?.id && !item.channel,
  );
  const chat = ownedChats.find((item) => item.id === chatId);
  const needsChat = mode === "existing" && !chat;

  function apply(next: {
    agentId: string;
    chatId: string;
    mode: string;
    oneClick: boolean;
  }) {
    setAgent(next.agentId);
    setChat(next.chatId);
    setMode(next.mode);
    setOneClick(next.oneClick);
    const nextAgent = agents.find((item) => item.id === next.agentId);
    const nextOwned = chats.filter(
      (item) => item.agentId === nextAgent?.id && !item.channel,
    );
    const nextChat = nextOwned.find((item) => item.id === next.chatId);
    const valid =
      (!next.agentId || !!nextAgent) &&
      (next.mode === "dedicated" || !!nextChat);
    if (!valid) {
      autoSave.cancelPending();
      return;
    }
    const payload: NoteHandover = {
      agentId: nextAgent?.id,
      chatId: next.mode === "existing" ? nextChat?.id : undefined,
      oneClick: next.oneClick,
    };
    autoSave.schedule(payload, handoverSignature(payload), "immediate");
  }

  return (
    <div className="task-handover-body">
      <FieldGroup>
        <Field>
          <FieldTitle>{t("tasks.handoverDefaultAgent")}</FieldTitle>
          <div className="flex min-w-0 items-center gap-2">
            <TaskAgentSelect
              agents={agents}
              label={t("tasks.handoverDefaultAgent")}
              value={agent?.id}
              className="flex-1"
              onChange={(id) => {
                if (agentId === id) return;
                apply({ agentId: id, chatId: "", mode, oneClick });
              }}
            />
            {agentId && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  apply({
                    agentId: "",
                    chatId: "",
                    mode: "dedicated",
                    oneClick,
                  })
                }
              >
                {t("tasks.handoverClearAgent")}
              </Button>
            )}
          </div>
        </Field>
        <Field>
          <FieldTitle>{t("automations.chatSource")}</FieldTitle>
          <ToggleGroup
            type="single"
            value={mode}
            variant="outline"
            aria-label={t("automations.chatSource")}
            onValueChange={(value) => {
              if (value && value !== mode)
                apply({ agentId, chatId, mode: value, oneClick });
            }}
          >
            <ToggleGroupItem value="dedicated">
              {t("automations.chatSource.dedicated")}
            </ToggleGroupItem>
            <ToggleGroupItem value="existing">
              {t("automations.chatSource.existing")}
            </ToggleGroupItem>
          </ToggleGroup>
          {mode === "existing" && (
            <SearchableSelect
              label={t("automations.selectChat")}
              placeholder={t("automations.selectChat")}
              searchLabel={t("conversationSearch.searchChats")}
              emptyLabel={t("tasks.noMatches")}
              value={chat?.id}
              options={ownedChats.map((item) => ({
                id: item.id,
                label: displayChatTitle(item, t),
              }))}
              onChange={(nextChatId) =>
                apply({ agentId, chatId: nextChatId, mode, oneClick })
              }
            />
          )}
          <FieldDescription>
            {t(
              needsChat ? "tasks.handoverSelectChat" : "tasks.handoverChatHelp",
            )}
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={oneClickId}>
              {t("tasks.oneClickHandover")}
            </FieldLabel>
            <FieldDescription id={oneClickId + "-help"}>
              {t("tasks.oneClickHandoverHelp")}
            </FieldDescription>
          </FieldContent>
          <Switch
            id={oneClickId}
            aria-describedby={oneClickId + "-help"}
            checked={oneClick}
            onCheckedChange={(checked) =>
              apply({ agentId, chatId, mode, oneClick: checked })
            }
          />
        </Field>
      </FieldGroup>
      {autoSave.saving && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("common.saving")}
        </p>
      )}
      {!!autoSave.error && (
        <ErrorNotice error={autoSave.error} retry={autoSave.retry} />
      )}
    </div>
  );
}
