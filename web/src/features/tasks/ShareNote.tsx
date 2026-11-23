import { useState } from "react";
import { api } from "@/api/client";
import type { TaskNote } from "@/api/types.gen";
import { useRemoteBindings } from "@/features/settings/RemoteDevices";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
type Preview = {
  assets?: number;
  title: string;
  body: string;
  version: string;
  link?: string;
};
export function ShareNote({ note }: { note: TaskNote }) {
  const { data } = useRemoteBindings();
  const choices = data?.filter((b) => b.role !== "executor") ?? [];
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState("");
  const selected =
    choices.find((b) => b.hubId + "/" + b.spaceId === choice) ?? choices[0];
  if (!selected) return null;
  const load = async (action: string) => {
    setBusy(true);
    setError("");
    try {
      setPreview(
        await api<Preview>("/remote", {
          action,
          id: note.id,
          noteVersion: preview?.version,
          scope: { hubId: selected.hubId, spaceId: selected.spaceId },
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setPreview(undefined);
          setOpen(true);
          void load("preview_note");
        }}
      >
        共享任务
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>从已保存的笔记创建共享任务</DialogTitle>
          {choices.length > 1 && (
            <select
              aria-label="目标空间"
              value={selected.hubId + "/" + selected.spaceId}
              onChange={(e) => {
                setChoice(e.target.value);
                setPreview(undefined);
              }}
            >
              {choices.map((b) => (
                <option
                  key={b.hubId + b.spaceId}
                  value={b.hubId + "/" + b.spaceId}
                >
                  {b.origin} · {b.spaceId}
                </option>
              ))}
            </select>
          )}
          {preview ? (
            <>
              <strong>{preview.title}</strong>
              {!!preview.assets && (
                <p>本机保留 {preview.assets} 个附件，共享正文包含附件名称。</p>
              )}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap">
                {preview.body}
              </pre>
              <p>共享正文文本，图片和附件原件保留在本机。</p>
              {preview.link ? (
                <a target="_blank" rel="noreferrer" href={preview.link}>
                  打开共享任务
                </a>
              ) : (
                <Button disabled={busy} onClick={() => void load("share_note")}>
                  确认共享
                </Button>
              )}
            </>
          ) : (
            <Button disabled={busy} onClick={() => void load("preview_note")}>
              读取预览
            </Button>
          )}
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
