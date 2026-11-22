import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FileDiff } from "lucide-react";
import type { DiffFile, Run, RunChanges } from "@/api/types.gen";
import { Button } from "@/components/ui/button";

const previewFileCount = 3;

export type TurnSelection = {
  runId: string;
  rootId: string;
  sessionId: string;
  path?: string;
};
export const DiffNavigation = createContext<
  (selection: TurnSelection, owner: string) => void
>(() => {});

export function DiffStats({ files }: { files: DiffFile[] }) {
  return (
    <span className="diff-stats">
      <span className="diff-added">
        +{files.reduce((sum, file) => sum + file.additions, 0)}
      </span>
      <span className="diff-removed">
        −{files.reduce((sum, file) => sum + file.deletions, 0)}
      </span>
    </span>
  );
}

function TurnChangeCard({
  run,
  change,
  preview,
}: {
  run: Run;
  change: Pick<RunChanges, "root" | "files">;
  preview?: ReactNode;
}) {
  const { t } = useTranslation();
  const open = useContext(DiffNavigation);
  const [expanded, setExpanded] = useState(false);
  const filesId = useId();
  const remaining = change.files.length - previewFileCount;
  const files = expanded
    ? change.files
    : change.files.slice(0, previewFileCount);
  const selection = {
    runId: run.id,
    rootId: change.root.id,
    sessionId: run.sessionId,
  };
  const title = t("diff.fileCount", { count: change.files.length });

  return (
    <section className="turn-changes" aria-label={title}>
      <div className="turn-changes-summary">
        <span className="turn-changes-icon" aria-hidden="true">
          <FileDiff />
        </span>
        <div className="turn-changes-heading">
          <span>{title}</span>
          <DiffStats files={change.files} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => open(selection, run.agentId)}
        >
          {t("diff.viewChanges")}
        </Button>
      </div>
      <div className="turn-changes-files" id={filesId}>
        {files.map((file) => {
          const nameStart = file.path.lastIndexOf("/") + 1;
          return (
            <Button
              key={file.path}
              variant="ghost"
              className="turn-changes-file"
              title={file.path}
              onClick={() =>
                open({ ...selection, path: file.path }, run.agentId)
              }
            >
              <span className="turn-changes-path truncate">
                <span className="text-muted-foreground">
                  {file.path.slice(0, nameStart)}
                </span>
                {file.path.slice(nameStart)}
              </span>
              <DiffStats files={[file]} />
            </Button>
          );
        })}
      </div>
      {preview}
      {remaining > 0 && (
        <Button
          variant="ghost"
          className="turn-changes-toggle"
          aria-expanded={expanded}
          aria-controls={filesId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("diff.showFewerFiles")
            : t("diff.showMoreFiles", { count: remaining })}
          <ChevronDown data-icon="inline-end" />
        </Button>
      )}
    </section>
  );
}

export function TurnChanges({
  run,
  preview,
}: {
  run: Run;
  preview?: (rootId: string, file: DiffFile) => ReactNode;
}) {
  const { t } = useTranslation();
  if (!run.finishedAt && run.status !== "paused") return null;
  const native = run.turnDiff;
  if (native && !native.reported && !native.error) return null;
  const changes = native ? [native] : run.changes;
  const first = changes?.find(
    (change) => !change.error && change.files.some((file) => !file.binary),
  );
  const file = first?.files.find((item) => !item.binary);
  return (
    <>
      {changes?.map((change) =>
        change.error ? (
          <p
            key={change.root.id}
            className="text-xs text-muted-foreground"
            role="status"
          >
            {t("diff.captureFailed")}: {change.error}
          </p>
        ) : change.files.length > 0 ? (
          <TurnChangeCard
            key={change.root.id}
            run={run}
            change={change}
            preview={
              change === first && file
                ? preview?.(change.root.id, file)
                : undefined
            }
          />
        ) : null,
      )}
    </>
  );
}
