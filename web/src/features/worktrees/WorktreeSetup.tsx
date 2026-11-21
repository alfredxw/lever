import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { CopyCheckout } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import type { TerminalResult } from "@/features/terminal/TerminalPane";
import { directoryName } from "@/lib/paths";
import { worktreePath } from "./queries";

const TerminalPane = lazy(() => import("@/features/terminal/TerminalPane"));

export type SetupSelection = { path: string; command: string };
type SetupTarget = SetupSelection & { worktreeId: string; source: string };
type Job = SetupTarget & {
  id: string;
  state: "starting" | "running" | "done" | "failed";
  stream?: boolean;
  error?: string;
};
type Batch = { kind: "group" | "worktree"; jobs: Job[] };

const setupKey = (agentId: string) => `lever:worktree-setup:${agentId}`;

export function useWorktreeSetup(agentId: string) {
  const key = setupKey(agentId);
  const [batch, setBatch] = useState<Batch | undefined>(() => {
    const value = sessionStorage.getItem(key);
    if (!value) return;
    let saved: Batch;
    try {
      saved = JSON.parse(value);
    } catch {
      return;
    }
    // A reload can only attach to previously requested processes.
    return {
      kind: saved.kind ?? "group",
      jobs: saved.jobs.map((job) =>
        job.state === "starting"
          ? { ...job, state: "running", stream: true }
          : job,
      ),
    };
  });
  const current = useRef(batch);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (next: Batch | undefined) => {
    current.current = next;
    if (next) sessionStorage.setItem(key, JSON.stringify(next));
    else sessionStorage.removeItem(key);
    setBatch(next);
  };
  const pathFor = (job: Job) =>
    `${worktreePath(agentId)}/${job.worktreeId}/setup/${job.id}`;
  const change = (id: string, patch: Partial<Job>) => {
    const latest = current.current;
    if (mounted.current && latest?.jobs.some((job) => job.id === id)) {
      update({
        ...latest,
        jobs: latest.jobs.map((job) =>
          job.id === id ? { ...job, ...patch } : job,
        ),
      });
    }
  };
  const newJob = (target: SetupTarget): Job => ({
    ...target,
    id: crypto.randomUUID(),
    state: "starting",
    stream: false,
    error: undefined,
  });
  const launch = async (job: Job, previous?: Job) => {
    try {
      if (previous) await api(pathFor(previous), {}, "DELETE");
      await api(pathFor(job), { path: job.path, command: job.command });
      if (
        current.current?.jobs.find((item) => item.id === job.id)?.state ===
        "starting"
      )
        change(job.id, { state: "running", stream: true });
    } catch (error) {
      if (
        current.current?.jobs.find((item) => item.id === job.id)?.state ===
        "starting"
      )
        change(job.id, { state: "failed", error: (error as Error).message });
    }
  };
  return {
    batch,
    pathFor,
    start(
      kind: Batch["kind"],
      checkouts: CopyCheckout[],
      selection: SetupSelection[],
    ) {
      if (!mounted.current || current.current) return;
      const jobs = selection.flatMap((item) => {
        const checkout = checkouts.find(
          (checkout) => checkout.path === item.path,
        );
        return checkout
          ? [
              newJob({
                ...item,
                worktreeId: checkout.id,
                source: checkout.source,
              }),
            ]
          : [];
      });
      if (!jobs.length) return;
      update({ kind, jobs });
      for (const job of jobs) void launch(job);
    },
    retry(id: string) {
      const latest = current.current;
      const previous = latest?.jobs.find((job) => job.id === id);
      if (!latest || previous?.state !== "failed") return;
      const next = newJob(previous);
      change(id, next);
      void launch(next, previous);
    },
    result(id: string, result: TerminalResult, error: string) {
      if (
        current.current?.jobs.find((job) => job.id === id)?.state !== "running"
      )
        return;
      change(
        id,
        result.type === "exited" && result.code === 0
          ? { state: "done" }
          : { state: "failed", error },
      );
    },
    async stop() {
      const latest = current.current;
      if (!latest) return;
      await Promise.all(
        latest.jobs
          .filter((job) => job.state !== "done")
          .map(async (job) => {
            await api(pathFor(job), {}, "DELETE");
            if (
              current.current?.jobs.find((item) => item.id === job.id)
                ?.state !== "done"
            )
              change(job.id, { state: "failed" });
          }),
      );
    },
    finish() {
      if (!current.current) return;
      update(undefined);
    },
  };
}

export function WorktreeSetup({
  agentId,
  setup,
}: {
  agentId: string;
  setup: ReturnType<typeof useWorktreeSetup>;
}) {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<unknown>();
  const { jobs } = setup.batch!;
  const complete = jobs.every((job) => job.state === "done");
  useEffect(() => {
    if (complete) setup.finish();
  }, [complete, setup]);
  const active = jobs.some(
    (job) => job.state === "starting" || job.state === "running",
  );
  async function stop(useCopy = false) {
    setStopping(true);
    setError(undefined);
    try {
      await setup.stop();
      if (useCopy) setup.finish();
    } catch (error) {
      setError(error);
    } finally {
      setStopping(false);
    }
  }
  function outcome(result: TerminalResult) {
    if (result.type === "exited")
      return t("terminal.exited", { code: result.code });
    if (result.type === "error") return result.message;
    return t(`terminal.${result.type}`);
  }
  return (
    <div className="grid gap-3">
      <h3 className="font-medium">{t("worktrees.setupOutput")}</h3>
      <div className="space-y-3">
        {jobs.map((job) => {
          const name = directoryName(job.source);
          return (
            <section
              key={job.path}
              aria-label={name}
              className="space-y-2 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{name}</span>
                {job.state === "failed" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={stopping}
                    onClick={() => setup.retry(job.id)}
                  >
                    {t("common.retry")}
                  </Button>
                ) : (
                  <span role="status" className="text-xs text-muted-foreground">
                    {t(
                      job.state === "done"
                        ? "worktrees.setupDone"
                        : "worktrees.settingUp",
                    )}
                  </span>
                )}
              </div>
              <div className="break-all text-xs text-muted-foreground">
                {job.path}
              </div>
              <code className="block whitespace-pre-wrap break-words text-xs">
                {job.command}
              </code>
              {job.stream && job.state !== "done" && (
                <div className="relative h-40 overflow-hidden rounded-md border bg-background">
                  <Suspense fallback={<Loading />}>
                    <TerminalPane
                      key={job.id}
                      path={setup.pathFor(job)}
                      terminalId={job.id}
                      started
                      closing={stopping}
                      style={{ inset: 0 }}
                      selected={false}
                      readOnly
                      onResult={(result) =>
                        setup.result(job.id, result, outcome(result))
                      }
                    />
                  </Suspense>
                </div>
              )}
              {job.state === "failed" && (
                <ErrorNotice error={job.error ?? t("worktrees.setupStopped")} />
              )}
            </section>
          );
        })}
        {!!error && <ErrorNotice error={error} />}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {active ? (
          <Button
            type="button"
            variant="outline"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {t("worktrees.stopSetup")}
          </Button>
        ) : (
          !complete && (
            <Button
              type="button"
              variant="outline"
              disabled={stopping}
              onClick={() => void stop(true)}
            >
              {t("worktrees.skipSetup")}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
