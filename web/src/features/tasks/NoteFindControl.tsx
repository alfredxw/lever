import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Replace, Search } from "lucide-react";
import { useEditorState, type Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { noteHits, replaceHits, selectHit, setNoteQuery } from "./noteFind";
import type { Transaction } from "@tiptap/pm/state";

export type FindRequest = { text: string; replace: boolean };
export function NoteFindControl({
  editor,
  request,
  search,
  searchStep,
}: {
  editor: Editor | null;
  request?: FindRequest;
  search: string;
  searchStep: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (request) {
      setText(request.text);
      setReplacing(request.replace);
      setOpen(true);
      input.current?.select();
    }
  }, [request]);
  const query = open ? text : search;
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      const tr = setNoteQuery(editor.state, query);
      if (tr) editor.view.dispatch(tr);
    }
  }, [editor, query]);
  const lastStep = useRef(0);
  useEffect(() => {
    if (editor && searchStep && lastStep.current !== searchStep) {
      const tr = selectHit(editor.state, 1);
      if (tr) editor.view.dispatch(tr);
    }
    lastStep.current = searchStep;
  }, [editor, searchStep]);
  const count = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor || !open || !query) return "";
      const hits = noteHits(editor.state);
      const { from, to } = editor.state.selection;
      return (
        hits.findIndex((hit) => hit.from === from && hit.to === to) +
        1 +
        " / " +
        hits.length
      );
    },
  });
  function dispatch(tr: Transaction | undefined) {
    if (editor && !editor.view.composing && tr) editor.view.dispatch(tr);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("tasks.findInNote")}
        >
          <Search />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 space-y-2 p-2"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
      >
        <div className="flex items-center gap-1">
          <Input
            ref={input}
            type="search"
            aria-label={t("tasks.findInNote")}
            placeholder={t("tasks.findInNote")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && editor) {
                e.preventDefault();
                dispatch(selectHit(editor.state, e.shiftKey ? -1 : 1));
              }
            }}
          />
          <output className="shrink-0 text-xs tabular-nums">{count}</output>
          {([-1, 1] as const).map((dir) => (
            <Button
              key={dir}
              size="icon-xs"
              variant="ghost"
              aria-label={t(dir < 0 ? "tasks.prevMatch" : "tasks.nextMatch")}
              onClick={() => editor && dispatch(selectHit(editor.state, dir))}
            >
              {dir < 0 ? <ArrowUp /> : <ArrowDown />}
            </Button>
          ))}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("tasks.replace")}
            aria-pressed={replacing}
            onClick={() => setReplacing(!replacing)}
          >
            <Replace />
          </Button>
        </div>
        {replacing && (
          <div className="flex items-center gap-1">
            <Input
              value={replacement}
              aria-label={t("tasks.replacement")}
              onChange={(e) => setReplacement(e.target.value)}
            />
            {[false, true].map((all) => (
              <Button
                key={String(all)}
                variant="ghost"
                size="xs"
                onClick={() =>
                  editor &&
                  dispatch(replaceHits(editor.state, replacement, all))
                }
              >
                {t(all ? "tasks.replaceAll" : "tasks.replace")}
              </Button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
