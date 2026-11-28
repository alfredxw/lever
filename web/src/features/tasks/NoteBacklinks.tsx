import { useTranslation } from "react-i18next";
import type { TaskNoteSummary } from "@/api/types.gen";
import { Button } from "@/components/ui/button";

export function NoteBacklinks({
  id,
  library,
  onOpen,
}: {
  id: string;
  library: TaskNoteSummary[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const references = library.filter(
    (note) => note.state !== "deleted" && note.links?.includes(id),
  );
  if (!references.length) return null;
  return (
    <nav className="note-backlinks" aria-label={t("tasks.backlinks")}>
      <span>{t("tasks.backlinks")}</span>
      {references.map((note) => (
        <Button
          key={note.id}
          variant="ghost"
          size="sm"
          onClick={() => onOpen(note.id)}
        >
          {note.title}
        </Button>
      ))}
    </nav>
  );
}
