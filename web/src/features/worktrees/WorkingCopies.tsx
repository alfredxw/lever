import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Folders, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Agent, CopyCheckout, WorkingCopy } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabsContent } from "@/components/ui/tabs";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { directoryName } from "@/lib/paths";
import {
  checkoutName,
  copyPath,
  groupSummary,
  useWorkingCopies,
  worktreeKey,
  worktreePath,
  type WorktreeOwner,
} from "./queries";
import { ScopeEditor, type ScopeEdit } from "./ScopeEditor";
import { WorktreeSetup, type useWorktreeSetup } from "./WorktreeSetup";

type Action =
  | { kind: "archive" | "prepareGroup" | "deleteGroup"; group: WorkingCopy }
  | { kind: "prepareWorktree" | "deleteWorktree"; checkout: CopyCheckout };

export type ScopeTab = "directories" | ScopeEdit["kind"];

export function WorkingCopies({
  agentId,
  owner = "agent",
  agents,
  tab,
  canCreate,
  setup,
  setupFields,
}: {
  agentId: string;
  owner?: WorktreeOwner;
  agents?: Agent[];
  tab: ScopeTab;
  canCreate: boolean;
  setup: ReturnType<typeof useWorktreeSetup>;
  setupFields?: ReactNode;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const groups = useWorkingCopies(agentId, tab !== "directories", false, owner);
  const worktrees = useQuery({
    queryKey: worktreeKey(agentId, owner),
    queryFn: () => api<CopyCheckout[]>(worktreePath(agentId, owner)),
    enabled: tab === "worktree" && !!agentId,
  });
  const agentsById = agents
    ? new Map(agents.map((item) => [item.id, item]))
    : undefined;
  const [groupEdit, setGroupEdit] = useState<ScopeEdit>();
  const [worktreeEdit, setWorktreeEdit] = useState<ScopeEdit>();
  const [removing, setRemoving] = useState<CopyCheckout>();
  const [busy, setBusy] = useState(false);
  const action = useMutation({
    mutationFn: async (action: Action) => {
      if ("group" in action) {
        const path = `${copyPath(agentId, owner)}/${action.group.id}`;
        if (action.kind === "prepareGroup") await api(`${path}/prepare`, {});
        else if (action.kind === "archive")
          await api(path, { archived: !action.group.archived }, "PATCH");
        else await api(path, {}, "DELETE");
      } else {
        const path = `${worktreePath(agentId, owner)}/${action.checkout.id}`;
        if (action.kind === "prepareWorktree") await api(`${path}/prepare`, {});
        else await api(path, {}, "DELETE");
      }
    },
    onSuccess: (_, action) => {
      if (action.kind === "deleteWorktree") setRemoving(undefined);
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["working-copies"] }),
        client.invalidateQueries({ queryKey: ["worktrees"] }),
        client.invalidateQueries({ queryKey: ["worktree-options"] }),
      ]),
  });
  const mutating = busy || action.isPending || !!setup.batch;
  const repositories = new Map<string, CopyCheckout[]>();
  for (const checkout of worktrees.data ?? []) {
    const checkouts = repositories.get(checkout.source);
    if (checkouts) checkouts.push(checkout);
    else repositories.set(checkout.source, [checkout]);
  }
  const beginGroup = (source?: WorkingCopy, duplicate?: boolean) => {
    action.reset();
    setGroupEdit({
      kind: "group",
      source,
      duplicate,
      requestId: crypto.randomUUID(),
    });
  };
  const renderEditor = (edit: ScopeEdit, close: () => void) => (
    <ScopeEditor
      key={edit.requestId}
      agentId={agentId}
      owner={owner}
      edit={edit}
      submitDisabled={mutating || !canCreate}
      onBusy={setBusy}
      onBack={close}
      onReady={(checkouts, commands) => {
        close();
        if (commands.length) setup.start(edit.kind, checkouts, commands);
      }}
    />
  );
  const actionError = action.error && <ErrorNotice error={action.error} />;
  return (
    <>
      <TabsContent
        value="group"
        forceMount
        hidden={tab !== "group"}
        className="min-w-0 space-y-3"
      >
        {setup.batch?.kind === "group" ? (
          <WorktreeSetup agentId={agentId} setup={setup} />
        ) : groupEdit ? (
          renderEditor(groupEdit, () => setGroupEdit(undefined))
        ) : (
          <>
            {action.variables && "group" in action.variables && actionError}
            {groups.isPending && <Loading />}
            {!!groups.error && (
              <ErrorNotice
                error={groups.error}
                retry={() => void groups.refetch()}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {groups.data?.length === 0 && (
                <p className="text-muted-foreground">
                  {t("worktrees.emptyGroups")}
                </p>
              )}
              {canCreate && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={mutating}
                  onClick={() => beginGroup()}
                >
                  <Plus data-icon="inline-start" />
                  {t("worktrees.newGroup")}
                </Button>
              )}
            </div>
            {!!groups.data?.length && (
              <ul className="divide-y border-y">
                {groups.data?.map((group) => (
                  <li key={group.id} className="space-y-2 px-2 py-2">
                    <div className="flex items-center gap-2">
                      <Folders className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="break-words font-medium">
                          {group.name}
                        </div>
                        <div className="break-words text-xs text-muted-foreground">
                          {groupSummary(group)}
                          {group.archived && ` · ${t("worktrees.archived")}`}
                          {group.state === "preparing" &&
                            ` · ${t("worktrees.pending")}`}
                        </div>
                      </div>
                      <RowActions
                        label={t("worktrees.groupActions", {
                          name: group.name,
                        })}
                        disabled={mutating}
                      >
                        {canCreate && (
                          <>
                            <DropdownMenuItem
                              onSelect={() => beginGroup(group)}
                            >
                              {t("worktrees.editGroup")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => beginGroup(group, true)}
                            >
                              {t("worktrees.duplicateGroup")}
                            </DropdownMenuItem>
                            {group.state === "preparing" && (
                              <DropdownMenuItem
                                onSelect={() =>
                                  action.mutate({ kind: "prepareGroup", group })
                                }
                              >
                                {t("worktrees.retry")}
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                        <DropdownMenuItem
                          onSelect={() =>
                            action.mutate({ kind: "archive", group })
                          }
                        >
                          {t(
                            group.archived
                              ? "worktrees.unarchive"
                              : "worktrees.archive",
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            action.mutate({ kind: "deleteGroup", group })
                          }
                        >
                          {t("worktrees.deleteGroup")}
                        </DropdownMenuItem>
                      </RowActions>
                    </div>
                    {group.error && <ErrorNotice error={group.error} />}
                    {!!group.topics?.length && (
                      <details className="pl-6 text-xs text-muted-foreground">
                        <summary>
                          {t("worktrees.topics")} · {group.topics.length}
                        </summary>
                        <ul className="mt-1 space-y-1 pl-3">
                          {group.topics.map((topic) => {
                            const topicAgent = topic.agentId
                              ? agentsById?.get(topic.agentId)
                              : undefined;
                            return (
                              <li
                                key={topic.id}
                                className="flex items-center gap-1.5 break-words"
                              >
                                {topicAgent && (
                                  <AgentAvatar agent={topicAgent} size="xs" />
                                )}
                                <span className="min-w-0 truncate">
                                  {topicAgent ? `${topicAgent.name} · ` : ""}
                                  {topic.title || t("chat.topic")}
                                  {topic.busy && ` · ${t("worktrees.busy")}`}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </TabsContent>
      <TabsContent
        value="worktree"
        forceMount
        hidden={tab !== "worktree"}
        className="min-w-0 space-y-3"
      >
        {setup.batch?.kind === "worktree" ? (
          <WorktreeSetup agentId={agentId} setup={setup} />
        ) : worktreeEdit ? (
          renderEditor(worktreeEdit, () => setWorktreeEdit(undefined))
        ) : removing ? (
          <div className="grid gap-3">
            <h3 className="font-medium">
              {t(removing.base ? "worktrees.remove" : "worktrees.detach")}
            </h3>
            <p className="break-all text-xs text-muted-foreground">
              {removing.path}
            </p>
            <p className="text-muted-foreground">
              {t(
                removing.base ? "worktrees.removeHint" : "worktrees.detachHint",
              )}
            </p>
            {actionError}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={action.isPending}
                onClick={() => {
                  action.reset();
                  setRemoving(undefined);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={mutating}
                onClick={() =>
                  action.mutate({ kind: "deleteWorktree", checkout: removing })
                }
              >
                {t(removing.base ? "worktrees.remove" : "worktrees.detach")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {action.variables && "checkout" in action.variables && actionError}
            {(groups.isPending || worktrees.isPending) && <Loading />}
            {!!groups.error && (
              <ErrorNotice
                error={groups.error}
                retry={() => void groups.refetch()}
              />
            )}
            {!!worktrees.error && (
              <ErrorNotice
                error={worktrees.error}
                retry={() => void worktrees.refetch()}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {worktrees.data?.length === 0 && (
                <p className="text-muted-foreground">{t("worktrees.empty")}</p>
              )}
              {canCreate && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={mutating}
                  onClick={() => {
                    action.reset();
                    setWorktreeEdit({
                      kind: "worktree",
                      requestId: crypto.randomUUID(),
                    });
                  }}
                >
                  <Plus data-icon="inline-start" />
                  {t("worktrees.addWorktree")}
                </Button>
              )}
            </div>
            {[...repositories].map(([source, checkouts]) => (
              <div key={source} className="divide-y rounded-lg border">
                <div
                  className="truncate bg-muted/50 px-3 py-1.5 text-xs font-medium"
                  title={source}
                >
                  {directoryName(source)}
                </div>
                {checkouts.map((checkout) => {
                  const uses =
                    groups.data?.filter((group) =>
                      group.worktreeIds.includes(checkout.id),
                    ) ?? [];
                  return (
                    <div key={checkout.id} className="space-y-2 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="break-words font-medium">
                            {checkoutName(checkout)}
                          </div>
                          <div
                            className="truncate text-xs text-muted-foreground"
                            title={checkout.path}
                          >
                            {checkout.path}
                          </div>
                          {uses.length > 0 && (
                            <div className="break-words text-xs text-muted-foreground">
                              {t("worktrees.usedBy", {
                                groups: uses
                                  .map((group) => group.name)
                                  .join(" · "),
                              })}
                            </div>
                          )}
                        </div>
                        <RowActions
                          label={t("worktrees.worktreeActions", {
                            name: checkoutName(checkout),
                            repository: directoryName(source),
                          })}
                          disabled={mutating}
                        >
                          {!checkout.ready && canCreate && (
                            <DropdownMenuItem
                              onSelect={() =>
                                action.mutate({
                                  kind: "prepareWorktree",
                                  checkout,
                                })
                              }
                            >
                              {t("worktrees.retry")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={uses.length > 0}
                            onSelect={() => {
                              action.reset();
                              setRemoving(checkout);
                            }}
                          >
                            {t(
                              checkout.base
                                ? "worktrees.remove"
                                : "worktrees.detach",
                            )}
                          </DropdownMenuItem>
                        </RowActions>
                      </div>
                      {checkout.error && <ErrorNotice error={checkout.error} />}
                    </div>
                  );
                })}
              </div>
            ))}
            {setupFields}
          </>
        )}
      </TabsContent>
    </>
  );
}

function RowActions({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
