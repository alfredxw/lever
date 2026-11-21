import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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

export function NoteHandoverSettings(props: SettingsProps) {
  const { t } = useTranslation();
  const query = useQuery(noteHandoverQuery(props.note.id));
  const save = useMutation({
    mutationFn: (settings: NoteHandover) =>
      api<NoteHandover>(
        `/tasks/notes/${props.note.id}/handover`,
        settings,
        "PUT",
      ),
    onSuccess: (settings) => {
      queryClient.setQueryData(
        noteHandoverQuery(props.note.id).queryKey,
        settings,
      );
      props.onClose();
    },
  });
  return (
    <NoteHandoverSheet
      title={t("tasks.handoverSettings")}
      onClose={() => !save.isPending && props.onClose()}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      {query.data ? (
        <SettingsForm
          agents={props.agents}
          chats={props.chats}
          initial={query.data}
          onSave={save.mutate}
          saving={save.isPending}
          error={save.error}
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
  agents,
  chats,
  initial,
  onSave,
  saving,
  error,
}: Pick<SettingsProps, "agents" | "chats"> & {
  initial: NoteHandover;
  onSave: (settings: NoteHandover) => void;
  saving: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [agentId, setAgent] = useState(initial.agentId ?? "");
  const [chatId, setChat] = useState(initial.chatId ?? "");
  const [mode, setMode] = useState(initial.chatId ? "existing" : "dedicated");
  const [oneClick, setOneClick] = useState(initial.oneClick ?? false);
  const oneClickId = useId();
  const agent = agents.find((item) => item.id === agentId);
  const ownedChats = chats.filter(
    (item) => item.agentId === agent?.id && !item.channel,
  );
  const chat = ownedChats.find((item) => item.id === chatId);
  const canSave = (!agentId || !!agent) && (mode === "dedicated" || !!chat);
  return (
    <form
      className="task-handover-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && !saving)
          onSave({
            agentId: agent?.id,
            chatId: mode === "existing" ? chat?.id : undefined,
            oneClick,
          });
      }}
    >
      <div className="task-handover-body">
        <FieldGroup>
          <Field>
            <FieldTitle>{t("tasks.handoverDefaultAgent")}</FieldTitle>
            <div className="flex min-w-0 items-center gap-2">
              <TaskAgentSelect
                agents={agents}
                label={t("tasks.handoverDefaultAgent")}
                value={agent?.id}
                disabled={saving}
                className="flex-1"
                onChange={(id) => {
                  if (agentId === id) return;
                  setAgent(id);
                  setChat("");
                }}
              />
              {agentId && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setAgent("");
                    setChat("");
                    setMode("dedicated");
                  }}
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
              disabled={saving}
              onValueChange={(value) => value && setMode(value)}
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
                onChange={setChat}
                disabled={saving}
              />
            )}
            <FieldDescription>{t("tasks.handoverChatHelp")}</FieldDescription>
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
              onCheckedChange={setOneClick}
              disabled={saving}
            />
          </Field>
        </FieldGroup>
        {!!error && <ErrorNotice error={error} />}
      </div>
      <div className="task-handover-actions">
        <Button type="submit" disabled={!canSave || saving}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
