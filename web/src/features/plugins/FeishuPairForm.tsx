import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { Dialogs } from "@/api/desktop.gen";
import type { Agent, ChannelPairInput } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useProviders } from "@/features/runtime/queries";
import { connectionName } from "@/features/runtime/connections";

export function FeishuPairForm({
  candidate,
  botName,
  agents,
  defaultAgentId,
  busy,
  online,
  onRenew,
  onConfirm,
}: {
  candidate: string;
  botName: string;
  agents: Agent[];
  defaultAgentId?: string;
  busy: boolean;
  online: boolean;
  onRenew: () => void;
  onConfirm: (input: ChannelPairInput) => void;
}) {
  const { t } = useTranslation();
  const initialAgentId =
    defaultAgentId && agents.some((agent) => agent.id === defaultAgentId)
      ? defaultAgentId
      : "";
  const [mode, setMode] = useState(initialAgentId ? "existing" : "new");
  const [agentId, setAgentId] = useState(initialAgentId);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [directory, setDirectory] = useState("");
  const providers = useProviders();
  const available =
    providers.data?.filter((runtime) => runtime.available) ?? [];
  const providerId =
    provider || (available.length === 1 ? available[0].id : "");
  const create = mode === "new" || agents.length === 0;
  const pickDirectory = useMutation({
    mutationFn: () => Dialogs.pickDirectories(directory.trim(), false),
    onSuccess: ([path]) => {
      if (path) setDirectory(path);
    },
  });
  const disabled = busy || pickDirectory.isPending;
  const validTarget = create
    ? available.some((runtime) => runtime.id === providerId) &&
      directory.trim() !== ""
    : agents.some((agent) => agent.id === agentId);

  return (
    <form
      className="channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !validTarget) return;
        const target = create
          ? { newAgent: { provider: providerId, directory: directory.trim() } }
          : { agentId };
        onConfirm({ candidate, name, ...target });
      }}
    >
      <p className="text-sm">{t("channels.receivedPair")}</p>
      <code className="break-all text-xs text-muted-foreground">
        {candidate}
      </code>
      <ToggleGroup
        type="single"
        variant="outline"
        aria-label={t("channels.targetAgent")}
        value={create ? "new" : "existing"}
        disabled={disabled}
        onValueChange={(value) => {
          if (value) setMode(value);
        }}
      >
        <ToggleGroupItem value="new">{t("agents.create")}</ToggleGroupItem>
        <ToggleGroupItem value="existing" disabled={!agents.length}>
          {t("channels.useExistingAgent")}
        </ToggleGroupItem>
      </ToggleGroup>
      {create ? (
        <>
          <p className="break-words text-xs text-muted-foreground">
            {t("channels.newAgentName", { name: botName })}
          </p>
          <Field>
            <FieldLabel htmlFor="feishu-pair-provider">
              {t("profile.provider")}
            </FieldLabel>
            <Select
              value={providerId}
              onValueChange={setProvider}
              disabled={disabled || !available.length}
            >
              <SelectTrigger id="feishu-pair-provider" className="w-full">
                <SelectValue placeholder={t("channels.chooseRuntime")} />
              </SelectTrigger>
              <SelectContent>
                {available.map((runtime) => (
                  <SelectItem key={runtime.id} value={runtime.id}>
                    <RuntimeIcon provider={runtime} />
                    {connectionName(runtime, providers.data ?? [], t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {providers.error && (
              <ErrorNotice
                error={providers.error}
                retry={() => void providers.refetch()}
              />
            )}
            {providers.data && !available.length && (
              <p className="text-xs text-muted-foreground">
                {t("channels.enableRuntime")}
              </p>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="feishu-pair-directory">
              {t("channels.workingDirectory")}
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="feishu-pair-directory"
                className="min-w-0 flex-1"
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                disabled={disabled}
                autoComplete="off"
                required
              />
              {isMyGo() && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t("profile.addDirectory")}
                  disabled={disabled}
                  onClick={() => pickDirectory.mutate()}
                >
                  <FolderOpen />
                </Button>
              )}
            </div>
            {pickDirectory.error && <ErrorNotice error={pickDirectory.error} />}
          </Field>
        </>
      ) : (
        <AgentSelect
          id="feishu-pair-agent"
          agents={agents}
          value={agentId}
          onChange={setAgentId}
          disabled={disabled}
        />
      )}
      <Field>
        <FieldLabel htmlFor="feishu-private-chat-name">
          {t("channels.privateChatName")}
        </FieldLabel>
        <Input
          id="feishu-private-chat-name"
          placeholder={t("channels.privateChat")}
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={disabled}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        {t("channels.agentPermissions")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled || !validTarget}>
          {t(create ? "channels.createAndPair" : "channels.confirmPair")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || !online}
          onClick={onRenew}
        >
          {t("channels.newPairCode")}
        </Button>
      </div>
    </form>
  );
}

export function AgentSelect({
  id,
  agents,
  value,
  onChange,
  disabled,
}: {
  id: string;
  agents: Agent[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("channels.targetAgent")}</FieldLabel>
      <Select
        value={value}
        onValueChange={onChange}
        disabled={disabled || !agents.length}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={t("channels.chooseAgent")} />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
