import { useId, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, FolderOpen, Search } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type {
  Agent,
  Skill,
  SkillSubscription,
  SkillSubscriptionInput,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { skillsQuery, skillSubscriptionsQuery } from "./skillsQuery";
import { SkillOriginGlyph } from "./SkillOriginGlyph";

export type SkillDialogMode = "create" | "subscribe" | "directory";

const templates = ["blank", "review", "script"] as const;
type TemplateKind = (typeof templates)[number];
const policyOptions = ["inherit", "auto", "notify", "manual"] as const;

export function SkillDialog({
  mode: initialMode,
  agents = [],
  homeDir,
  onClose,
  onSaved,
  onSubscribed,
}: {
  mode: SkillDialogMode;
  agents?: Agent[];
  homeDir: string;
  onClose: () => void;
  onSaved: (skill: Skill, edit: boolean) => void;
  onSubscribed?: (sub: SkillSubscription) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const descId = useId();
  const subNameId = useId();
  const subPathId = useId();
  const subRefId = useId();

  const [mode, setMode] = useState<SkillDialogMode>(initialMode);
  const nameField = useState("");
  const directoryField = useState("");
  const [value, setValue] = mode === "directory" ? directoryField : nameField;
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<TemplateKind>("blank");

  const [subUrl, setSubUrl] = useState("");
  const [subName, setSubName] = useState("");
  const [subPath, setSubPath] = useState("");
  const [subRef, setSubRef] = useState("");
  const [subPolicy, setSubPolicy] =
    useState<SkillSubscription["updatePolicy"]>("inherit");

  const [attachScope, setAttachScope] = useState<"none" | "selected">("none");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [agentQuery, setAgentQuery] = useState("");

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLocaleLowerCase();
    if (!q) return activeAgents;
    return activeAgents.filter((a) => a.name.toLocaleLowerCase().includes(q));
  }, [activeAgents, agentQuery]);

  const pick = useMutation({
    mutationFn: () => Dialogs.pickDirectories(value.trim() || homeDir, false),
    onSuccess: ([directory]) => {
      if (directory) setValue(directory);
    },
  });

  const saveSkill = useMutation({
    mutationFn: async () => {
      const skill = await api<Skill>(
        "/skills",
        mode === "create"
          ? {
              name: value.trim(),
              description: description.trim() || undefined,
              template,
            }
          : { directory: value.trim() },
      );
      if (
        mode === "directory" &&
        attachScope === "selected" &&
        selectedAgentIds.length > 0
      ) {
        const byId = new Map(activeAgents.map((a) => [a.id, a]));
        for (const agentId of selectedAgentIds) {
          const target = byId.get(agentId);
          if (!target) continue;
          await api(
            `/agents/${agentId}/skills`,
            {
              updatedAt: target.updatedAt,
              attach: skill.path,
            },
            "PATCH",
          );
        }
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
      }
      return skill;
    },
    onSuccess: (skill) => {
      void queryClient.cancelQueries(skillsQuery);
      queryClient.setQueryData(skillsQuery.queryKey, (skills) => [
        ...(skills ?? []).filter((item) => item.id !== skill.id),
        {
          ...skill,
          origin: skills?.find((item) => item.id === skill.id)?.origin,
        },
      ]);
      void queryClient.invalidateQueries(skillsQuery);
      onSaved(skill, mode === "create");
    },
  });

  const saveSub = useMutation({
    mutationFn: () => {
      const body: SkillSubscriptionInput = {
        url: subUrl.trim(),
        name: subName.trim() || undefined,
        path: subPath.trim() || undefined,
        ref: subRef.trim() || undefined,
        updatePolicy: subPolicy,
      };
      return api<SkillSubscription>("/skill-subscriptions", body);
    },
    onSuccess: (sub) => {
      void queryClient.invalidateQueries(skillsQuery);
      void queryClient.invalidateQueries(skillSubscriptionsQuery);
      toast.success(t("skills.subscriptionAdded", { count: sub.skillCount }));
      onSubscribed?.(sub);
      onClose();
    },
  });

  const error = saveSkill.error ?? saveSub.error ?? pick.error;
  const busy = saveSkill.isPending || saveSub.isPending || pick.isPending;

  const canSubmit =
    !busy && (mode === "subscribe" ? !!subUrl.trim() : !!value.trim());

  function switchMode(next: SkillDialogMode) {
    if (busy || next === mode) return;
    saveSkill.reset();
    saveSub.reset();
    setMode(next);
  }

  function toggleSelectedAgent(agentId: string) {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{t("profile.addSkill")}</DialogTitle>
          <DialogDescription>{t("skills.choosePath")}</DialogDescription>
        </DialogHeader>

        <div
          className="skills-add-paths"
          role="group"
          aria-label={t("skills.choosePath")}
        >
          <button
            type="button"
            className="skills-path-card"
            aria-pressed={mode === "create"}
            disabled={busy}
            onClick={() => switchMode("create")}
          >
            <div className="skills-path-head">
              <SkillOriginGlyph kind="managed" compact />
              <span>{t("skills.create")}</span>
            </div>
            <p className="skills-path-desc">{t("skills.createDesc")}</p>
            <span className="skills-path-dest">data/skills/</span>
          </button>

          <button
            type="button"
            className="skills-path-card"
            aria-pressed={mode === "subscribe"}
            disabled={busy}
            onClick={() => switchMode("subscribe")}
          >
            <div className="skills-path-head">
              <SkillOriginGlyph kind="subscribed" compact />
              <span>{t("skills.subscribeRepo")}</span>
            </div>
            <p className="skills-path-desc">{t("skills.subscribeDesc")}</p>
            <span className="skills-path-dest">data/skill-subscriptions/</span>
          </button>

          <button
            type="button"
            className="skills-path-card"
            aria-pressed={mode === "directory"}
            disabled={busy}
            onClick={() => switchMode("directory")}
          >
            <div className="skills-path-head">
              <SkillOriginGlyph kind="external" compact />
              <span>{t("skills.addDirectory")}</span>
            </div>
            <p className="skills-path-desc">{t("skills.directoryDesc")}</p>
            <span className="skills-path-dest">
              {t("skills.linkedInPlace")}
            </span>
          </button>
        </div>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!canSubmit) return;
            if (mode === "subscribe") saveSub.mutate();
            else saveSkill.mutate();
          }}
        >
          {mode === "create" && (
            <>
              <Field>
                <FieldLabel htmlFor={inputId}>{t("skills.name")}</FieldLabel>
                <Input
                  id={inputId}
                  value={value}
                  placeholder="my-skill"
                  autoFocus
                  disabled={busy}
                  onChange={(event) => {
                    saveSkill.reset();
                    setValue(event.target.value);
                  }}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={descId}>
                  {t("skills.descriptionLabel")}
                </FieldLabel>
                <Input
                  id={descId}
                  value={description}
                  placeholder={t("skills.descriptionPlaceholder")}
                  disabled={busy}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel>{t("skills.template")}</FieldLabel>
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  spacing={0}
                  className="w-full"
                  disabled={busy}
                  value={template}
                  onValueChange={(next) => {
                    if (next) setTemplate(next as TemplateKind);
                  }}
                >
                  {templates.map((item) => (
                    <ToggleGroupItem
                      key={item}
                      value={item}
                      className="flex-1 text-xs"
                    >
                      {t(`skills.template.${item}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </>
          )}

          {mode === "subscribe" && (
            <>
              <Field>
                <FieldLabel htmlFor={inputId}>
                  {t("skills.subscriptionUrl")}
                </FieldLabel>
                <Input
                  id={inputId}
                  value={subUrl}
                  placeholder="https://github.com/org/team-skills.git"
                  autoFocus
                  disabled={busy}
                  onChange={(event) => {
                    saveSub.reset();
                    setSubUrl(event.target.value);
                  }}
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={subNameId}>
                    {t("skills.subscriptionName")}
                  </FieldLabel>
                  <Input
                    id={subNameId}
                    value={subName}
                    placeholder="team-skills"
                    disabled={busy}
                    onChange={(event) => setSubName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={subRefId}>
                    {t("skills.subscriptionRef")}
                  </FieldLabel>
                  <Input
                    id={subRefId}
                    value={subRef}
                    placeholder="main"
                    disabled={busy}
                    onChange={(event) => setSubRef(event.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor={subPathId}>
                  {t("skills.subscriptionPath")}
                </FieldLabel>
                <Input
                  id={subPathId}
                  value={subPath}
                  placeholder="skills"
                  disabled={busy}
                  onChange={(event) => setSubPath(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel>{t("updates.policy")}</FieldLabel>
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  spacing={0}
                  className="w-full"
                  disabled={busy}
                  value={subPolicy}
                  onValueChange={(next) => {
                    if (next)
                      setSubPolicy(next as SkillSubscription["updatePolicy"]);
                  }}
                >
                  {policyOptions.map((item) => (
                    <ToggleGroupItem
                      key={item}
                      value={item}
                      className="flex-1 text-xs"
                    >
                      {t(`updates.policy.${item}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </>
          )}

          {mode === "directory" && (
            <>
              <Field>
                <FieldLabel htmlFor={inputId}>
                  {t("profile.skillDirectory")}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={inputId}
                    value={value}
                    placeholder="/path/to/skill"
                    autoFocus
                    disabled={busy}
                    onChange={(event) => {
                      saveSkill.reset();
                      setValue(event.target.value);
                    }}
                  />
                  {isMyGo() && (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        type="button"
                        size="icon-xs"
                        aria-label={t("skills.chooseDirectory")}
                        title={t("skills.chooseDirectory")}
                        disabled={busy}
                        onClick={() => pick.mutate()}
                      >
                        <FolderOpen />
                      </InputGroupButton>
                    </InputGroupAddon>
                  )}
                </InputGroup>
              </Field>

              {activeAgents.length > 0 && (
                <Field>
                  <FieldLabel>{t("skills.scopeChoice")}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    size="sm"
                    variant="outline"
                    spacing={0}
                    className="w-full"
                    disabled={busy}
                    value={attachScope}
                    onValueChange={(next) => {
                      if (next === "none" || next === "selected") {
                        setAttachScope(next);
                      }
                    }}
                  >
                    <ToggleGroupItem value="none" className="flex-1 text-xs">
                      {t("skills.scopeChoiceNone")}
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="selected"
                      className="flex-1 text-xs"
                    >
                      {t("skills.scopeChoiceSelected", {
                        count: selectedAgentIds.length,
                      })}
                    </ToggleGroupItem>
                  </ToggleGroup>

                  {attachScope === "selected" && (
                    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-2">
                      <InputGroup>
                        <InputGroupAddon>
                          <Search />
                        </InputGroupAddon>
                        <InputGroupInput
                          type="search"
                          placeholder={t("skills.searchAgents")}
                          value={agentQuery}
                          onChange={(e) => setAgentQuery(e.target.value)}
                        />
                      </InputGroup>
                      <div className="grid max-h-36 gap-0.5 overflow-y-auto">
                        {filteredAgents.map((agent) => {
                          const checked = selectedAgentIds.includes(agent.id);
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              className="flex items-center gap-2 rounded-md px-2 py-1 text-start text-xs hover:bg-control-hover"
                              aria-pressed={checked}
                              onClick={() => toggleSelectedAgent(agent.id)}
                            >
                              <AgentAvatar agent={agent} size="sm" />
                              <span className="min-w-0 flex-1 truncate">
                                {agent.name}
                              </span>
                              {checked && (
                                <Check className="size-3.5 shrink-0" />
                              )}
                            </button>
                          );
                        })}
                        {filteredAgents.length === 0 && (
                          <p className="px-2 py-2 text-xs text-muted-foreground">
                            {t("skills.noAgentsFound")}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </Field>
              )}
            </>
          )}

          {error && <ErrorNotice error={error} />}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t(
                mode === "create"
                  ? "skills.createAction"
                  : mode === "subscribe"
                    ? "skills.addSubscription"
                    : "skills.addAction",
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
