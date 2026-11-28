import { useRef, useState } from "react";
import { FileInput } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { importNoteFile } from "./noteFiles";

export function NoteImport({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        title={t("tasks.importFile")}
        aria-label={t("tasks.importFile")}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <FileInput />
      </Button>
      <input
        type="file"
        ref={input}
        hidden
        accept=".md,.markdown,.zip,.pdf"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setBusy(true);
          try {
            onOpen((await importNoteFile(file)).id);
          } catch (e) {
            toast.error(String(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
