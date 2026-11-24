import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type {
  CheckoutOptions,
  CopyCheckout,
  CopyChoice,
  CopyOptions,
  WorkingCopy,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { directoryName } from "@/lib/paths";
import {
  checkoutName,
  copyKey,
  copyPath,
  useWorkingCopies,
  useWorkingCopyOptions,
  worktreePath,
  type WorktreeOwner,
} from "./queries";
import type { SetupSelection } from "./WorktreeSetup";

export type ScopeEdit =
  | {
      kind: "group";
      requestId: string;
      source?: WorkingCopy;
      duplicate?: boolean;
    }
  | { kind: "worktree"; requestId: string };

type Callbacks = {
  submitDisabled: boolean;
  onReady: (checkouts: CopyCheckout[], setup: SetupSelection[]) => void;
  onBack: () => void;
  onBusy: (busy: boolean) => void;
};

export function ScopeEditor({
  agentId,
  owner = "agent",
  edit,
  ...callbacks
}: { agentId: string; owner?: WorktreeOwner; edit: ScopeEdit } & Callbacks) {
  const { t } = useTranslation();
  const options = useWorkingCopyOptions(agentId, edit.requestId, owner);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const title =
    edit.kind === "worktree"
      ? t("worktrees.addWorktree")
      : edit.duplicate
        ? t("worktrees.duplicateGroup")
        : edit.source
          ? t("worktrees.editGroup")
          : t("worktrees.newGroup");
  return (
    <div className="grid gap-3">
      <h3 ref={heading} tabIndex={-1} className="font-medium outline-none">
        {title}
      </h3>
      {options.isSuccess && options.data.groups.length ? (
        <ScopeForm
          key={JSON.stringify(options.data.groups.map((repo) => repo.source))}
          agentId={agentId}
          owner={owner}
          edit={edit}
          options={options.data}
          {...callbacks}
        />
      ) : (
        <>
          {options.isPending ? (
            <Loading />
          ) : options.error ? (
            <ErrorNotice
              error={options.error}
              retry={() => void options.refetch()}
            />
          ) : (
            <p className="text-muted-foreground">
              {t("worktrees.noRepository")}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={callbacks.onBack}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

type Choice = { target: string; base: string; skipSetup?: boolean };
const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");

function ScopeForm({
  agentId,
  owner,
  edit,
  options,
  submitDisabled,
  onReady,
  onBack,
  onBusy,
}: {
  agentId: string;
  owner: WorktreeOwner;
  edit: ScopeEdit;
  options: CopyOptions;
} & Callbacks) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const creatingWorktree = edit.kind === "worktree";
  const source = edit.kind === "group" ? edit.source : undefined;
  const editing = edit.kind === "group" && !edit.duplicate ? source : undefined;
  const [name, setName] = useState(() =>
    edit.kind === "group" && edit.duplicate && source
      ? t("worktrees.copyName", { name: source.name })
      : (source?.name ?? ""),
  );
  const [repository, setRepository] = useState(
    () =>
      options.groups.find((repo) =>
        repo.rootIds.includes(options.primaryRootId),
      )?.source ?? options.groups[0].source,
  );
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      options.groups.map((repo) => [
        repo.source,
        {
          target: creatingWorktree
            ? repo.head
              ? "new"
              : (repo.existing[0]?.path ?? "")
            : (source?.checkouts.find(
                (checkout) => checkout.source === repo.source,
              )?.path ?? "shared"),
          base: repo.bases[0]?.subject ?? "",
        },
      ]),
    ),
  );
  const repositories = creatingWorktree
    ? options.groups.filter((repo) => repo.source === repository)
    : options.groups;
  const changed = repositories.flatMap<CopyChoice>((repo) => {
    const choice = choices[repo.source];
    if (choice.target === "shared") return [];
    if (choice.target === "new")
      return [
        {
          source: repo.source,
          base: repo.bases.find((base) => base.subject === choice.base)?.hash,
        },
      ];
    return [
      {
        source: repo.source,
        path: repo.existing.find((entry) => entry.path === choice.target)?.path,
      },
    ];
  });
  const setup = repositories.flatMap((repo) =>
    choices[repo.source].target === "new" &&
    repo.setup &&
    !choices[repo.source].skipSetup
      ? [{ path: repo.newPath, command: repo.setup }]
      : [],
  );
  const creates = changed.filter((choice) => choice.base).length;
  const targetPath = (repo: CheckoutOptions) => {
    const target = choices[repo.source].target;
    return target === "new"
      ? repo.newPath
      : target === "shared" || !target
        ? repo.source
        : target;
  };
  const roots = options.roots.map((root) => {
    const repo = repositories.find((repo) => repo.rootIds.includes(root.id));
    const target = repo && targetPath(repo);
    return {
      ...root,
      shared: !repo || target === repo.source,
      actual:
        repo && target
          ? `${normalize(target)}${normalize(root.path).slice(normalize(repo.source).length)}`
          : root.path,
    };
  });
  const exposed = !creatingWorktree
    ? repositories.filter(
        (repo) =>
          targetPath(repo) !== repo.source &&
          roots.some((root) => {
            const path = normalize(root.path);
            const source = normalize(repo.source);
            return (
              root.shared && (source === path || source.startsWith(`${path}/`))
            );
          }),
      )
    : [];
  const valid =
    ((creatingWorktree && !creates) || !!name.trim()) &&
    changed.length > 0 &&
    changed.every((choice) => choice.base || choice.path);
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  const save = useMutation<WorkingCopy | CopyCheckout>({
    mutationFn: () => {
      if (creatingWorktree)
        return api<CopyCheckout>(worktreePath(agentId, owner), {
          id: edit.requestId,
          name: name.trim(),
          choice: changed[0],
        });
      const path = copyPath(agentId, owner);
      return api<WorkingCopy>(
        editing ? `${path}/${editing.id}` : path,
        {
          id: edit.requestId,
          name: name.trim(),
          choices: changed,
          scope: { roots: options.roots, primaryRootId: options.primaryRootId },
        },
        editing ? "PUT" : "POST",
      );
    },
    onSuccess: (value) => {
      if ("checkouts" in value) {
        client.setQueryData<WorkingCopy[]>(
          copyKey(agentId, owner),
          (previous) => [
            value,
            ...(previous ?? []).filter((copy) => copy.id !== value.id),
          ],
        );
        if (value.state === "ready" && !value.error)
          onReady(value.checkouts, setup);
      } else if (value.ready) onReady([value], setup);
    },
    onSettled: () => {
      submitting.current = false;
      onBusy(false);
      void client.invalidateQueries({ queryKey: ["working-copies"] });
      void client.invalidateQueries({ queryKey: ["worktrees"] });
      void client.invalidateQueries({ queryKey: ["worktree-options"] });
    },
  });
  const progress = useWorkingCopies(
    agentId,
    !creatingWorktree && save.isPending,
    !creatingWorktree && save.isPending ? 750 : false,
    owner,
  );
  const saved = save.data;
  const checkouts = saved
    ? "checkouts" in saved
      ? saved.checkouts
      : [saved]
    : progress.data?.find(
        (group) => group.id === (editing?.id ?? edit.requestId),
      )?.checkouts;
  const action = submitted
    ? t("worktrees.retry")
    : setup.length
      ? t("worktrees.createAndSetup")
      : creatingWorktree
        ? t(creates ? "worktrees.new" : "worktrees.addExisting")
        : creates
          ? t("worktrees.confirmCreate", { count: creates })
          : t("worktrees.saveGroup");
  return (
    <form
      className="grid min-w-0 gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!valid || submitDisabled || submitting.current) return;
        submitting.current = true;
        setSubmitted(true);
        onBusy(true);
        save.mutate();
      }}
    >
      <div className="min-w-0 space-y-3">
        {creatingWorktree && (
          <Select
            value={repository}
            onValueChange={setRepository}
            disabled={submitted}
          >
            <SelectTrigger
              className="w-full"
              aria-label={t("worktrees.repository")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.groups.map((repo) => (
                <SelectItem
                  key={repo.source}
                  value={repo.source}
                  title={repo.source}
                >
                  {directoryName(repo.source)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(!creatingWorktree || creates > 0) && (
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("worktrees.name")}
            aria-label={t("worktrees.name")}
            disabled={submitted}
            required
            maxLength={100}
          />
        )}
        {repositories.map((repo) => {
          const choice = choices[repo.source];
          const status = submitted
            ? checkouts?.find(
                (checkout) =>
                  checkout.source === repo.source &&
                  checkout.path === targetPath(repo),
              )
            : undefined;
          return (
            <RepositoryField
              key={repo.source}
              repo={repo}
              choice={choice}
              disabled={submitted}
              creatingWorktree={creatingWorktree}
              change={(patch) =>
                setChoices((old) => ({
                  ...old,
                  [repo.source]: { ...old[repo.source], ...patch },
                }))
              }
            >
              {(save.isPending || status) && choice.target !== "shared" && (
                <div
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  role="status"
                >
                  {status?.ready ? (
                    <Check className="size-3.5" />
                  ) : (
                    save.isPending && (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    )
                  )}
                  {t(status?.ready ? "worktrees.ready" : "worktrees.pending")}
                </div>
              )}
            </RepositoryField>
          );
        })}
        {!creatingWorktree && (
          <ul className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            {roots.map((root) => (
              <li key={root.id} className="truncate" title={root.actual}>
                {root.id === options.primaryRootId && (
                  <span className="font-medium text-foreground">
                    {t("worktrees.cwd")} ·{" "}
                  </span>
                )}
                {root.actual}
              </li>
            ))}
          </ul>
        )}
        {exposed.map((repo) => (
          <p
            key={repo.source}
            className="break-all text-xs text-muted-foreground"
            role="note"
          >
            {t("worktrees.overlap", { path: repo.source })}
          </p>
        ))}
        {creates > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("worktrees.committedOnly")}
          </p>
        )}
        {(save.error || saved?.error) && (
          <ErrorNotice error={save.error ?? saved?.error} />
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={save.isPending}
          onClick={onBack}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={!valid || submitDisabled || save.isPending}
        >
          {save.isPending && (
            <LoaderCircle className="animate-spin" data-icon="inline-start" />
          )}
          {action}
        </Button>
      </div>
    </form>
  );
}

function RepositoryField({
  repo,
  choice,
  change,
  disabled,
  creatingWorktree,
  children,
}: {
  repo: CheckoutOptions;
  choice: Choice;
  change: (patch: Partial<Choice>) => void;
  disabled: boolean;
  creatingWorktree: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const name = directoryName(repo.source);
  const selection = repo.existing.find((entry) => entry.path === choice.target);
  const missing =
    !selection &&
    choice.target !== "shared" &&
    choice.target !== "new" &&
    choice.target;
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <div className="font-medium">{name}</div>
          <div
            className="truncate text-xs text-muted-foreground"
            title={repo.source}
          >
            {repo.source}
          </div>
        </div>
        <div className="w-44 max-w-full">
          <Select
            value={choice.target}
            disabled={disabled}
            onValueChange={(target) => change({ target })}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("worktrees.repositoryMode", { name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!creatingWorktree && (
                <SelectItem value="shared">{t("worktrees.shared")}</SelectItem>
              )}
              {repo.existing.map((entry) => (
                <SelectItem
                  key={entry.path}
                  value={entry.path}
                  title={entry.path}
                >
                  {checkoutName(entry)}
                </SelectItem>
              ))}
              {missing && (
                <SelectItem value={missing} disabled>
                  {directoryName(missing)}
                </SelectItem>
              )}
              <SelectItem value="new" disabled={!repo.bases.length}>
                {t("worktrees.new")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {choice.target === "new" && (
          <div className="w-44 max-w-full">
            <Select
              value={choice.base}
              disabled={disabled}
              onValueChange={(base) => change({ base })}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("worktrees.base", { name })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repo.bases.map((base) => (
                  <SelectItem key={base.subject} value={base.subject}>
                    {base.subject} · {base.hash.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {selection && (
        <p
          className="truncate text-xs text-muted-foreground"
          title={selection.path}
        >
          {selection.path}
        </p>
      )}
      {missing && (
        <p className="break-all text-xs text-destructive">{missing}</p>
      )}
      {choice.target === "new" && (
        <>
          <div
            className="truncate text-xs text-muted-foreground"
            title={`${repo.newBranch} · ${repo.newPath}`}
          >
            {repo.newBranch} · {repo.newPath}
          </div>
          {repo.setup && (
            <label className="flex items-start gap-2 rounded-md bg-muted p-2 text-xs">
              <Checkbox
                checked={!choice.skipSetup}
                onCheckedChange={(checked) =>
                  change({ skipSetup: checked !== true })
                }
              />
              <span className="min-w-0">
                <span>{t("worktrees.runSetup")}</span>
                <code className="mt-1 block whitespace-pre-wrap break-all">
                  {repo.setup}
                </code>
              </span>
            </label>
          )}
        </>
      )}
      {children}
    </fieldset>
  );
}
