import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Trash2,
} from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type { Agent, Overview, Project, Root, Scope } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
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
  InputGroupInput,
} from "@/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { WorktreeSetupFields } from "@/features/worktrees/WorktreeSetup";
import { directoryName } from "@/lib/paths";

function defaultRoots(homeDir: string, initialScope?: Scope): {
  roots: Root[];
  primaryRootId: string;
} {
  const valid = initialScope?.roots.filter((r) => r.path.trim()) ?? [];
  if (valid.length > 0) {
    const roots = valid.map((r) => ({ id: r.id || crypto.randomUUID(), path: r.path }));
    const primaryRootId = roots.some((r) => r.id === initialScope?.primaryRootId)
      ? initialScope!.primaryRootId
      : roots[0].id;
    return { roots, primaryRootId };
  }
  const id = crypto.randomUUID();
  return { roots: [{ id, path: homeDir || "~" }], primaryRootId: id };
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  initialScope,
  initialWorktreeSetup,
  agents,
  homeDir,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project;
  initialScope?: Scope;
  initialWorktreeSetup?: Record<string, string>;
  agents: Agent[];
  homeDir: string;
  onSaved?: (project: Project) => void;
  onDeleted?: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const formId = useId();
  const desktop = isMyGo();
  const nameInput = useRef<HTMLInputElement>(null);
  const editing = !!project;

  const [name, setName] = useState("");
  const [roots, setRoots] = useState<Root[]>([]);
  const [primaryRootId, setPrimaryRootId] = useState("");
  const [worktreeSetup, setWorktreeSetup] = useState<Record<string, string>>({});
  const [enteringPath, setEnteringPath] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const payload: Project = {
        id: project?.id ?? "",
        name: name.trim(),
        roots,
        primaryRootId,
        worktreeSetup: Object.keys(worktreeSetup).length ? worktreeSetup : undefined,
        createdAt: project?.createdAt ?? "",
        updatedAt: project?.updatedAt ?? "",
      };
      return editing
        ? api<Project>(`/projects/${project.id}`, payload, "PUT")
        : api<Project>("/projects", payload, "POST");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Overview>(["overview"], (data) =>
        data
          ? {
              ...data,
              projects: editing
                ? (data.projects ?? []).map((item) =>
                    item.id === saved.id ? saved : item,
                  )
                : [...(data.projects ?? []), saved],
            }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["working-copies"] });
      void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      void queryClient.invalidateQueries({ queryKey: ["worktree-options"] });
      onSaved?.(saved);
      onOpenChange(false);
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/projects/${project!.id}`, {}, "DELETE"),
    onSuccess: () => {
      const removedId = project!.id;
      setConfirmDelete(false);
      queryClient.setQueryData<Overview>(["overview"], (data) =>
        data
          ? {
              ...data,
              projects: (data.projects ?? []).filter(
                (item) => item.id !== removedId,
              ),
            }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["working-copies"] });
      void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      toast.success(t("projects.deleted"));
      onDeleted?.(removedId);
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    if (project) {
      setName(project.name);
      setRoots(project.roots.map((r) => ({ ...r })));
      setPrimaryRootId(project.primaryRootId);
      setWorktreeSetup({ ...(project.worktreeSetup ?? {}) });
    } else {
      const initial = defaultRoots(homeDir, initialScope);
      const primary = initial.roots.find((r) => r.id === initial.primaryRootId);
      const suggested =
        initialScope && primary && primary.path !== homeDir && primary.path !== "~"
          ? directoryName(primary.path)
          : "";
      setName(suggested);
      setRoots(initial.roots);
      setPrimaryRootId(initial.primaryRootId);
      setWorktreeSetup({ ...(initialWorktreeSetup ?? {}) });
    }
    setEnteringPath(false);
    setConfirmDelete(false);
    save.reset();
    remove.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  const addDirectories = (paths: string[]) => {
    if (!paths.length) return;
    const added = [...new Set(paths)].filter(
      (path) => !roots.some((root) => root.path === path),
    );
    if (!added.length) {
      toast.info(t("profile.directoryAlreadyAdded"));
      return;
    }
    const next = roots.map((root) => {
      const path = root.path.trim() ? undefined : added.shift();
      return path ? { ...root, path } : root;
    });
    next.push(...added.map((path) => ({ id: crypto.randomUUID(), path })));
    setRoots(next);
    if (!primaryRootId || !next.some((root) => root.id === primaryRootId)) {
      setPrimaryRootId(next[0].id);
    }
    if (!editing && !name.trim() && next[0]?.path) {
      const base = directoryName(next[0].path);
      if (base && base !== "~") setName(base);
    }
  };

  const cwd = roots.find((root) => root.id === primaryRootId)?.path ?? "";

  const pickDirectory = useMutation({
    mutationFn: () => {
      const path = cwd || homeDir;
      return Dialogs.pickDirectories(path === "~" ? homeDir : path, true);
    },
    onSuccess: (paths) => addDirectories(paths),
    onError: (error) =>
      toast.error(t("profile.directoryPickerError"), {
        description: error.message,
      }),
  });

  const openDirectory = useMutation({
    mutationFn: Dialogs.openDirectory,
    onError: (error) =>
      toast.error(t("profile.directoryOpenError"), {
        description: error.message,
      }),
  });

  const linkedAgents = editing
    ? agents.filter((item) => item.profile.projectId === project.id)
    : [];

  const busy = save.isPending || remove.isPending || pickDirectory.isPending;
  const canSave =
    !busy &&
    !!name.trim() &&
    roots.length > 0 &&
    roots.every((root) => !!root.path.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="dialog-surface max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameInput.current?.focus();
          nameInput.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(editing ? "projects.edit" : "projects.create")}
          </DialogTitle>
          <DialogDescription>
            {t(editing ? "projects.editHint" : "projects.createHint")}
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          className="grid max-h-[65vh] gap-4 overflow-y-auto py-1 pr-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${fieldId}-name`}>
              {t("profile.name")}
            </FieldLabel>
            <Input
              ref={nameInput}
              id={`${fieldId}-name`}
              placeholder={t("projects.namePlaceholder")}
              maxLength={100}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          {editing && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("projects.linkedAgentsCount", { count: linkedAgents.length })}
              </span>
              {linkedAgents.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {linkedAgents.map((item) => (
                    <span
                      key={item.id}
                      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
                    >
                      <AgentAvatar agent={item} size="xs" />
                      <span className="max-w-36 truncate">{item.name}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("projects.noLinkedAgents")}
                </p>
              )}
            </div>
          )}

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel id={`${fieldId}-scope`}>
                {t("profile.scope")}
              </FieldLabel>
              <div className="flex items-center gap-1">
                {desktop && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => pickDirectory.mutate()}
                  >
                    <FolderPlus data-icon="inline-start" />
                    {t("profile.addDirectory")}
                  </Button>
                )}
                {(!desktop || enteringPath) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      const next = { id: crypto.randomUUID(), path: "" };
                      setRoots((current) => [...current, next]);
                      if (!primaryRootId) setPrimaryRootId(next.id);
                    }}
                  >
                    {t("profile.addDirectory")}
                  </Button>
                )}
                {desktop && !enteringPath && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEnteringPath(true)}
                  >
                    {t("profile.enterDirectoryPath")}
                  </Button>
                )}
              </div>
            </div>
            <RadioGroup
              aria-labelledby={`${fieldId}-scope`}
              value={primaryRootId}
              disabled={busy}
              onValueChange={setPrimaryRootId}
              className="grid gap-2"
            >
              {roots.map((root, index) => (
                <div key={root.id} className="flex items-center gap-2">
                  <RadioGroupItem
                    value={root.id}
                    aria-label={t("profile.defaultDirectory", {
                      path: root.path || String(index + 1),
                    })}
                    title={t("profile.defaultDirectory", {
                      path: root.path || String(index + 1),
                    })}
                  />
                  <InputGroup className="min-w-0 flex-1">
                    <InputGroupAddon align="inline-start">
                      <FolderOpen className="size-3.5 text-muted-foreground" />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label={t("profile.scopeDirectory")}
                      placeholder="/path/to/workspace"
                      value={root.path}
                      disabled={busy}
                      onChange={(event) =>
                        setRoots((current) =>
                          current.map((item) =>
                            item.id === root.id
                              ? { ...item, path: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </InputGroup>
                  {desktop && root.path.trim() && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("profile.openDirectory")}
                      title={t("profile.openDirectory")}
                      disabled={busy}
                      onClick={() => openDirectory.mutate(root.path)}
                    >
                      <ExternalLink />
                    </Button>
                  )}
                  {roots.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("common.remove")}
                      title={t("common.remove")}
                      disabled={busy}
                      onClick={() => {
                        const next = roots.filter((_, i) => i !== index);
                        setRoots(next);
                        if (primaryRootId === root.id) {
                          setPrimaryRootId(next[0]?.id ?? "");
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              ))}
            </RadioGroup>
          </Field>

          {editing && (
            <Collapsible className="border-t pt-2">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="worktree-setup-toggle w-full justify-between"
                >
                  <span>{t("worktrees.setupCommands")}</span>
                  <ChevronDown />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="px-1 pt-1">
                <WorktreeSetupFields
                  ownerId={project.id}
                  owner="project"
                  formId={formId}
                  commands={worktreeSetup}
                  onChange={setWorktreeSetup}
                />
              </CollapsibleContent>
            </Collapsible>
          )}

          {(save.error || remove.error) && (
            <ErrorNotice error={save.error ?? remove.error} />
          )}

          {editing && confirmDelete && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
              <span>{t("projects.deleteConfirmDescription")}</span>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={remove.isPending}
                  onClick={() => setConfirmDelete(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {t("projects.deleteConfirmAction")}
                </Button>
              </div>
            </div>
          )}
        </form>

        <DialogFooter className="items-center">
          {editing && !confirmDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 data-icon="inline-start" />
              {t("projects.delete")}
            </Button>
          )}
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              {t("common.cancel")}
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={!canSave}>
            {t(
              save.isPending
                ? "profile.saving"
                : editing
                  ? "common.save"
                  : "projects.createAction",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
