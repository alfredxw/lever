import type { EditorProps } from "@tiptap/pm/view";

function straightQuotes(text: string) {
  return text.replace(/[‘’]/g, "'");
}

// A Pinyin IME can add syllable boundaries while appending a letter.
// Stop tracking if the user enters punctuation or the IME replaces the word.
export function pinyinPreedit(previous: string | undefined, data: string) {
  if (previous === undefined) return;
  const display = straightQuotes(data);
  if (display === previous || /^[a-z]+$/i.test(display)) return display;
  if (!/^[a-z]+(?:'[a-z]+)*'?$/i.test(display)) return;
  const letters = display.replaceAll("'", "");
  if (
    previous.startsWith(display) ||
    letters.slice(0, -1) === previous.replaceAll("'", "")
  )
    return display;
}

export function composerCompositionEvents(): NonNullable<
  EditorProps["handleDOMEvents"]
> {
  let start = 0;
  let preedit: string | undefined;

  return {
    compositionstart(view) {
      start = view.state.selection.from;
      preedit = "";
    },
    keydown(_view, event) {
      if (event.code === "Quote" || /^['‘’]$/.test(event.key))
        preedit = undefined;
    },
    compositionupdate(_view, { data }) {
      preedit = pinyinPreedit(preedit, data);
    },
    compositionend(view, { data }) {
      const display = preedit;
      const from = start;
      preedit = undefined;
      if (!display?.includes("'") || straightQuotes(data) !== display) return;

      // Some input sources commit the marked text verbatim on a language
      // switch. Let ProseMirror read the native commit before editing its range.
      queueMicrotask(() => {
        if (view.isDestroyed || view.composing) return;
        const { doc, selection, tr } = view.state;
        if (
          selection.empty &&
          selection.from === from + data.length &&
          straightQuotes(doc.textBetween(from, selection.from)) === display
        ) {
          for (let i = display.length - 1; i >= 0; i--) {
            if (display[i] === "'") tr.delete(from + i, from + i + 1);
          }
          view.dispatch(tr.setMeta("addToHistory", false));
        }
      });
    },
  };
}
