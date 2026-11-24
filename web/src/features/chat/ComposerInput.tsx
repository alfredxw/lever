import {
  useContext,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { NativeCommand, Reference, SessionGoal } from "@/api/types.gen";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import { ReferenceNode } from "./ReferenceNode";
import { ComposerSuggestion } from "./ComposerSuggestion";
import { useMentionSources } from "./useMentionSources";
import { markdownPrompt, promptExtensions, serializePrompt } from "./prompt";
import {
  matchComposerTrigger,
  rankMentionGroups,
  searchComposerOptions,
  type ComposerTrigger,
} from "./composerSearch";
import { composerCompositionEvents } from "./composerComposition";
import { hasDraggedFiles } from "./composerFiles";
import {
  actionOptions,
  goalOptions,
  runtimeOptions,
  type ComposerBrowser,
  type ComposerCommand,
  type ComposerOption as Option,
} from "./composerActions";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { useComposerShortcuts } from "@/features/settings/Preferences";
import { ComposerContext, ReferenceScopeContext } from "./ComposerContext";

const extensions = [...promptExtensions, ReferenceNode];

export type ComposerInputHandle = { focus: (position?: "end") => void };

type Trigger = ComposerTrigger & { passive?: boolean };
type DismissedTrigger = { prefix: string; start: number };
type Actions = {
  id: string;
  browser: ComposerBrowser | null;
  navigate: (browser: ComposerBrowser | null) => void;
  attach: () => void;
  runApprovals?: { allowed: boolean; toggle: () => void };
};

export function ComposerInput({
  chatId,
  draftAgentId,
  sessionId,
  workingCopyId,
  provider,
  nativeCommands,
  commandText,
  goal,
  runtimeType,
  actions,
  scopeKey,
  reply,
  fixedDestination,
  suggestions = true,
  useAgentProfiles,
  canStartComparison,
  canStartAfter,
  waitingForRuns,
  collaboratorIds,
  value,
  empty,
  onChange,
  onCommand,
  textbox,
  onSubmit,
  onFiles,
  onEscape,
  label,
  placeholder,
  disabled,
  visible: isVisible,
  autoFocus,
}: {
  chatId: string;
  draftAgentId?: string;
  sessionId?: string;
  workingCopyId?: string;
  provider: string;
  nativeCommands?: { session?: NativeCommand[]; catalog?: NativeCommand[] };
  commandText?: string;
  goal?: SessionGoal;
  runtimeType?: string;
  actions?: Actions;
  scopeKey: string;
  reply?: boolean;
  fixedDestination?: boolean;
  suggestions?: boolean;
  useAgentProfiles?: boolean;
  canStartComparison: boolean;
  canStartAfter?: boolean;
  waitingForRuns?: boolean;
  collaboratorIds?: string[];
  value: JSONContent;
  empty: boolean;
  onChange: (content: JSONContent) => void;
  onCommand: (command: ComposerCommand) => void;
  textbox: RefObject<ComposerInputHandle | null>;
  onSubmit: (alternate: boolean) => void;
  onFiles?: (files: File[]) => void;
  onEscape?: () => void;
  label: string;
  placeholder: string;
  disabled?: boolean;
  visible?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const composer = useContext(ComposerContext);
  const referenceScope = useMemo(
    () => ({ sessionId, workingCopyId }),
    [sessionId, workingCopyId],
  );
  const inserted = useRef<string>(undefined);
  const compositionEvents = useMemo(composerCompositionEvents, []);
  const shortcuts = useComposerShortcuts();
  const listId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const dismissed = useRef<DismissedTrigger[]>([]);
  const [highlight, setHighlight] = useState<{
    search: string;
    id: string;
  } | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const browser = actions?.browser;
  const kind = browser?.page ?? trigger?.kind;
  const commandList =
    kind === "command" || kind === "actions" || kind === "goal";
  const lookupKind = commandList ? "slash" : "file";
  const query = (browser ?? trigger)?.query ?? "";
  const mentions = useMentionSources(
    kind === "mention",
    query,
    sessionId,
    collaboratorIds,
  );
  const searchKey = JSON.stringify([
    chatId,
    sessionId,
    workingCopyId,
    scopeKey,
    provider,
    kind,
    !!browser,
    query,
  ]);
  useEffect(() => {
    const timer = setTimeout(() => setFileQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const lookup = useQuery({
    queryKey: [
      "composer-suggestions",
      chatId,
      draftAgentId,
      sessionId,
      workingCopyId,
      scopeKey,
      provider,
      lookupKind,
      kind === "mention" ? fileQuery : "",
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ kind: lookupKind, provider });
      if (sessionId) params.set("sessionId", sessionId);
      if (workingCopyId) params.set("workingCopyId", workingCopyId);
      if (kind === "mention") params.set("query", fileQuery);
      return api<Reference[]>(
        `${draftAgentId ? `/agents/${draftAgentId}` : `/chats/${chatId}`}/suggestions?${params}`,
        undefined,
        "GET",
        signal,
      );
    },
    enabled: commandList || (kind === "mention" && query === fileQuery),
    staleTime: kind === "mention" ? 10_000 : 60_000,
    retry: false,
  });
  const commands: Option[] = commandList
    ? (
        [
          ...(reply || fixedDestination ? [] : ["chat", "topic"]),
          ...(useAgentProfiles ? [] : ["model"]),
          ...(canStartComparison || useAgentProfiles ? ["compare"] : []),
          ...(canStartAfter || waitingForRuns ? ["after"] : []),
        ] as ComposerCommand[]
      ).map((command) => ({
        id: `command:${command}`,
        name: `/${command}`,
        description:
          command === "compare" && useAgentProfiles
            ? t("comparison.cancel")
            : command === "after" && waitingForRuns
              ? t("after.cancel")
              : t(`composer.command.${command}`),
        command,
      }))
    : [];
  const suggestionsData = lookup.data ?? [];
  const plainDraft =
    browser &&
    value.content?.every(
      (block) =>
        block.type === "paragraph" &&
        (block.content ?? []).every(
          (node) => node.type === "text" && !node.marks?.length,
        ),
    );
  const draftAsGoal =
    !!commandText &&
    !/^(?:\/|(?:status|show|pause|resume|clear|edit)$)/i.test(commandText);
  const native =
    commandList &&
    commandText !== undefined &&
    !useAgentProfiles &&
    (browser ? plainDraft : trigger?.start === 1)
      ? runtimeOptions(
          nativeCommands?.session ?? [
            ...(nativeCommands?.catalog ?? []),
            ...suggestionsData.filter((entry) => entry.kind === "command"),
          ],
        )
          .filter(
            (option) =>
              !browser || empty || (option.name === "/goal" && draftAsGoal),
          )
          .map((option): Option => {
            if (!browser || option.name !== "/goal") return option;
            if (draftAsGoal)
              return { ...option, description: t("composer.goalFromDraft") };
            if (goal)
              return {
                ...option,
                description: t("composer.goalManage"),
                action: "goal",
              };
            return { ...option, description: t("composer.goalSet") };
          })
      : [];
  const references: Option[] = suggestionsData
    .filter((reference) => reference.kind !== "command")
    .map((reference) => {
      const separator = reference.name.lastIndexOf("/");
      const root = reference.description
        ?.replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop();
      return {
        id: `${reference.kind}:${reference.provider}:${reference.path}:${reference.name}`,
        name:
          reference.kind === "file"
            ? reference.name.slice(separator + 1)
            : `/${reference.name}`,
        description:
          reference.kind === "file"
            ? [root, reference.name.slice(0, Math.max(0, separator))]
                .filter(Boolean)
                .join("/")
            : (reference.description ?? ""),
        reference,
      };
    });
  const filesPending = kind === "mention" && query !== fileQuery;
  const lookups =
    kind === "mention"
      ? [lookup, ...mentions.queries]
      : commandList
        ? [lookup]
        : [];
  const loading = filesPending || lookups.some((item) => item.isLoading);
  const failed = lookups.filter((item) => item.isError);
  function sections() {
    switch (kind) {
      case "actions":
        return [
          {
            label: "",
            options: actionOptions(
              t,
              commands,
              native,
              references,
              query,
              actions?.runApprovals?.allowed,
            ),
          },
        ];
      case "goal":
        return [
          {
            label: goal?.objective ?? "",
            options:
              goal && empty && native.some((option) => option.name === "/goal")
                ? searchComposerOptions(
                    goalOptions(t, goal.status, runtimeType),
                    query,
                  )
                : [],
          },
        ];
      case "command":
        return [
          {
            label: t("composer.commandsGroup"),
            options: searchComposerOptions(commands, query),
          },
          {
            label: t("composer.nativeCommands"),
            options: searchComposerOptions(native, query).slice(
              0,
              references.length ? 20 : 40,
            ),
          },
          {
            label: t("composer.skillsGroup"),
            options: searchComposerOptions(
              references,
              runtimeType === "pi" ? query.replace(/^\/?skill:/i, "") : query,
            ),
          },
        ];
      case "mention":
        return [
          {
            label: t("composer.file"),
            options: filesPending ? [] : references,
          },
          ...mentions.groups,
        ];
      default:
        return [];
    }
  }
  const matched = sections().filter((section) => section.options.length);
  const nonempty =
    kind === "mention" ? rankMentionGroups(matched, query) : matched;
  const perGroup =
    kind === "mention" && nonempty.length > 1 ? (query ? 6 : 2) : 40;
  const visible: Option[] = [];
  const groups = nonempty.map(({ label, options }) => {
    const start = visible.length;
    visible.push(...options.slice(0, Math.min(perGroup, 40 - start)));
    return { label, start, end: visible.length };
  });
  const selectedIndex = Math.max(
    0,
    highlight?.search === searchKey
      ? visible.findIndex((option) => option.id === highlight.id)
      : 0,
  );
  const selected = visible[selectedIndex];
  const hideEmptyTrigger =
    !browser &&
    !!trigger &&
    !visible.length &&
    (trigger.passive ||
      (trigger.kind === "mention" && trigger.query.includes(" ")));
  const menuOpen = !disabled && !!(browser || (trigger && !hideEmptyTrigger));
  function highlightOption(index: number) {
    const option = visible[index];
    if (
      option &&
      (highlight?.search !== searchKey || highlight.id !== option.id)
    )
      setHighlight({ search: searchKey, id: option.id });
  }
  function rememberDismissed(target: Trigger | null) {
    if (!target) return;
    const { prefix, start } = target;
    if (
      !dismissed.current.some(
        (entry) => entry.prefix === prefix && entry.start === start,
      )
    )
      dismissed.current.push({ prefix, start });
  }
  function dismiss(rememberTrigger = true) {
    if (rememberTrigger) rememberDismissed(trigger);
    setTrigger(null);
    if (browser) actions?.navigate(null);
  }
  const browsePage = browser?.page;
  useLayoutEffect(() => {
    if (browsePage) {
      setHighlight(null);
      searchInput.current?.focus();
      if (trigger) {
        rememberDismissed(trigger);
        setTrigger(null);
      }
    }
  }, [browsePage, trigger]);
  useEffect(() => {
    menu.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, selected?.id]);

  function locate(target: Editor, edited: boolean) {
    if (!suggestions) return;
    const { selection } = target.state;
    const { $from } = selection;
    if (target.isActive("codeBlock") || target.isActive("code")) {
      setTrigger(null);
      return;
    }
    const before = $from.parent.textBetween(
      0,
      $from.parentOffset,
      "",
      "\ufffc",
    );
    const candidate = selection.empty
      ? matchComposerTrigger(before, selection.from)
      : null;
    if (
      candidate &&
      dismissed.current.some(
        (entry) =>
          entry.prefix === candidate.prefix && entry.start === candidate.start,
      )
    ) {
      setTrigger(null);
      return;
    }
    setTrigger((current) => {
      if (!candidate) return null;
      const passive = edited
        ? false
        : current &&
            current.prefix === candidate.prefix &&
            current.start === candidate.start
          ? current.passive
          : true;
      return { ...candidate, passive };
    });
  }

  function handleMenuKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      if (browser) editor?.commands.focus();
      return true;
    }
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (visible.length)
        highlightOption(
          (selectedIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            visible.length) %
            visible.length,
        );
      return true;
    }
    if (
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      (event.key === "Enter" || (event.key === "Tab" && selected))
    ) {
      event.preventDefault();
      if (selected) choose(selected);
      return true;
    }
    if (event.key === "Tab" && !browser) dismiss();
    return false;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || editor?.view.composing)
      return false;
    if (menuOpen && handleMenuKey(event)) return true;
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return true;
    }
    if (
      event.key === "Enter" &&
      shortcuts.modified &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      onSubmit(event.shiftKey);
      return true;
    }
    if (
      event.key === "Enter" &&
      (event.shiftKey || shortcuts.modified) &&
      editor
    ) {
      event.preventDefault();
      const { $from, empty } = editor.state.selection;
      const fence = /^(`{3,}|~{3,})([\w+-]*)$/.exec($from.parent.textContent);
      if (
        empty &&
        $from.parent.type.name === "paragraph" &&
        $from.parentOffset === $from.parent.content.size &&
        fence &&
        editor.can().setCodeBlock()
      ) {
        editor
          .chain()
          .setCodeBlock({ language: fence[2] })
          .deleteRange({ from: $from.start(), to: $from.end() })
          .run();
        return true;
      }
      // Preserve paragraph, list, and fenced-code editing for either shortcut.
      editor.commands.first(({ commands }) => [
        () => commands.splitListItem("listItem"),
        () =>
          editor.isActive("codeBlock") &&
          editor.state.selection.$from.parentOffset ===
            editor.state.selection.$from.parent.content.size &&
          editor.state.selection.$from.parent.textContent.endsWith("\n\n") &&
          commands.exitCode(),
        () => commands.newlineInCode(),
        () => commands.createParagraphNear(),
        () => commands.liftEmptyBlock(),
        () => commands.splitBlock(),
      ]);
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit(event.metaKey || event.ctrlKey);
      return true;
    }
    return false;
  }

  const editor: Editor | null = useEditor({
    extensions,
    content: value,
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        "aria-autocomplete": suggestions ? "list" : "none",
        "aria-haspopup": suggestions ? "listbox" : "false",
        "aria-controls": menuOpen && !browser ? listId : "",
        "aria-activedescendant":
          menuOpen && !browser && selected ? `${listId}-${selectedIndex}` : "",
        "aria-disabled": String(!!disabled),
        class: "prompt-editor",
        "data-slot": "input-group-control",
      },
      handleKeyDown: (_view, event) => handleKeyDown(event),
      handleClick: (view, _pos, event) => {
        if (event.button !== 0 || event.altKey || !view.editable) return false;
        const element =
          event.target instanceof Element
            ? event.target
            : event.target instanceof globalThis.Node
              ? event.target.parentElement
              : null;
        if (!element || element.closest("button, [data-reference]"))
          return false;
        const link = element.closest("a");
        if (!link || !view.dom.contains(link)) return false;
        if (!link.getAttribute("href")?.trim()) return false;
        window.open(link.href, link.target || "_blank", "noopener,noreferrer");
        return true;
      },
      handleDOMEvents: compositionEvents,
      clipboardTextSerializer: (slice) =>
        serializePrompt({ type: "doc", content: slice.content.toJSON() }).text,
      handleDrop: (_view, event, _slice, moved) => {
        if (moved || !onFiles || !hasDraggedFiles(event.dataTransfer))
          return false;
        event.preventDefault();
        return true;
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        if (data.files.length) {
          event.preventDefault();
          onFiles?.(Array.from(data.files));
          return true;
        }
        // Native HTML paste preserves copied reference identity and formatting.
        // Code stays literal, including Markdown and shell $variables.
        if (
          data.getData("text/html") ||
          editor?.isActive("codeBlock") ||
          editor?.isActive("code")
        )
          return false;
        const text = data.getData("text/plain");
        if (!text) return false;
        event.preventDefault();
        const content = Fragment.fromJSON(
          view.state.schema,
          markdownPrompt(text).content,
        );
        view.dispatch(
          closeHistory(view.state.tr)
            .replaceSelection(Slice.maxOpen(content))
            .scrollIntoView()
            .setMeta("paste", true)
            .setMeta("uiEvent", "paste"),
        );
        return true;
      },
    },
    onTransaction: ({ editor, transaction }) => {
      if (!transaction.docChanged || !dismissed.current.length) return;
      const { doc } = editor.state;
      dismissed.current = dismissed.current.flatMap((entry) => {
        const mapped = transaction.mapping.mapResult(entry.start, 1);
        if (mapped.deleted) return [];
        return doc.textBetween(
          mapped.pos,
          Math.min(mapped.pos + 1, doc.content.size),
          "",
          "\ufffc",
        ) === entry.prefix
          ? [{ ...entry, start: mapped.pos }]
          : [];
      });
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON());
      locate(editor, true);
    },
    onSelectionUpdate: ({ editor, transaction }) => {
      if (!transaction.docChanged) locate(editor, false);
    },
  });
  useImperativeHandle(
    textbox,
    () => ({
      focus: (position) => {
        editor?.commands.focus(position);
      },
    }),
    [editor],
  );
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  useLayoutEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(value)) {
      editor.commands.setContent(value, { emitUpdate: false });
      dismissed.current = [];
      setTrigger(null);
    }
  }, [editor, value]);

  useEffect(() => {
    if (isVisible === false) return;
    const key = reply ? sessionId! : chatId;
    const insertion = composer?.insertions.get(key);
    if (
      !composer ||
      !editor ||
      disabled ||
      !insertion ||
      (insertion.kind !== "reply" && insertion.kind !== "reference") ||
      inserted.current === insertion.id
    )
      return;
    inserted.current = insertion.id;
    const doc = editor.state.doc;
    if (insertion.kind === "reply") {
      editor
        .chain()
        .insertContentAt(doc.content.size, insertion.content)
        .focus("end")
        .run();
      onCommand("chat");
      composer.inserted(key, insertion.id);
      return;
    }
    const inline = [
      ...(doc.lastChild?.content.size ? [{ type: "text", text: " " }] : []),
      { type: "reference", attrs: { reference: insertion.reference } },
      { type: "text", text: " " },
    ];
    const paragraph = doc.lastChild?.type.name === "paragraph";
    editor
      .chain()
      .focus("end")
      .insertContentAt(
        doc.content.size - (paragraph ? 1 : 0),
        paragraph ? inline : { type: "paragraph", content: inline },
      )
      .run();
    composer.inserted(key, insertion.id);
  }, [editor, disabled, isVisible, composer, chatId, sessionId, reply, onCommand]);

  function choose(option: Option) {
    if (!editor || disabled) return;
    if (option.action) {
      if (option.action === "attach" || option.action === "runApprovals") {
        dismiss();
        editor.commands.focus();
        if (option.action === "attach") actions?.attach();
        else actions?.runApprovals?.toggle();
      } else {
        setHighlight(null);
        actions?.navigate({ page: option.action, query: "" });
      }
      return;
    }
    if (browser && option.command) {
      dismiss(false);
      // Opening the model or Agent picker hands keyboard focus to that picker.
      if (
        option.command !== "model" &&
        (option.command !== "compare" || useAgentProfiles)
      )
        editor.commands.focus();
      onCommand(option.command);
      return;
    }
    const { selection, doc } = editor.state;
    // Browsing never replaces the editor selection. Native commands start the
    // message; references go immediately after the saved selection.
    const position = option.native ? 1 : selection.to;
    let range = { from: position, to: position };
    if (!browser) {
      if (
        !trigger ||
        !selection.empty ||
        selection.from !== trigger.end ||
        doc.textBetween(trigger.start, trigger.end, "", "\ufffc") !==
          `${trigger.prefix}${trigger.query}`
      )
        return;
      const next = doc.textBetween(
        trigger.end,
        Math.min(trigger.end + 1, doc.content.size),
        "",
        "\ufffc",
      );
      range = {
        from: trigger.start,
        to:
          trigger.end +
          (next === " " && (option.reference || option.native) ? 1 : 0),
      };
    }
    const chain = editor
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr);
        return true;
      });
    if (option.native) {
      chain.insertContentAt(range, { type: "text", text: option.name + " " });
      if (browser && !empty) chain.focus("end");
    } else if (option.reference) {
      const { description: _description, ...reference } = option.reference;
      const content = [
        { type: "reference", attrs: { reference } },
        { type: "text", text: " " },
      ];
      if (browser && selection.$to.parent.type.spec.code) {
        chain.insertContentAt(selection.$to.after(), {
          type: "paragraph",
          content,
        });
      } else {
        chain.insertContentAt(range, content);
      }
    } else if (!browser) chain.deleteRange(range);
    chain.run();
    editor.view.dispatch(closeHistory(editor.state.tr));
    dismiss(false);
    if (option.command) onCommand(option.command);
  }

  const searchLabel = t(
    kind === "mention"
      ? "composer.mentions"
      : kind === "goal"
        ? "composer.goalManage"
        : "composer.searchActions",
  );
  return (
    <Popover
      open={menuOpen}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <PopoverAnchor asChild>
        <div className="prompt-root">
          {empty && (
            <span className="prompt-placeholder" aria-hidden="true">
              {placeholder}
            </span>
          )}
          <ReferenceScopeContext.Provider value={referenceScope}>
            <EditorContent className="prompt-clip" editor={editor} />
          </ReferenceScopeContext.Provider>
        </div>
      </PopoverAnchor>
      <PopoverContent
        id={browser && actions ? `${actions.id}-panel` : undefined}
        aria-label={browser ? t("composer.actions") : undefined}
        side="top"
        align="start"
        className="composer-suggestions"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (browser) searchInput.current?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229)
            event.preventDefault();
          else if (browser) handleMenuKey(event);
        }}
        onInteractOutside={(event) => {
          if (
            event.target instanceof globalThis.Node &&
            ((!browser && editor?.view.dom.contains(event.target)) ||
              (actions &&
                document.getElementById(actions.id)?.contains(event.target)))
          )
            event.preventDefault();
        }}
      >
        {browser && (
          <div className="composer-action-search">
            {browser.page !== "actions" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("composer.backToActions")}
                onClick={() =>
                  actions?.navigate({ page: "actions", query: "" })
                }
              >
                <ArrowLeft />
              </Button>
            )}
            <Input
              ref={searchInput}
              role="combobox"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listId}
              aria-activedescendant={
                selected ? `${listId}-${selectedIndex}` : undefined
              }
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) =>
                actions?.navigate({
                  page: browser.page,
                  query: event.target.value,
                })
              }
              onKeyDown={(event) => {
                if (
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                )
                  handleMenuKey(event.nativeEvent);
              }}
            />
          </div>
        )}
        <div
          id={listId}
          role="listbox"
          aria-label={t(
            kind === "mention"
              ? "composer.mentions"
              : kind === "command"
                ? "composer.command"
                : "composer.actions",
          )}
          aria-busy={loading}
          ref={menu}
        >
          {groups.map((group, groupIndex) => {
            const items = visible.slice(group.start, group.end);
            if (!items.length) return null;
            const headingId = `${listId}-group-${groupIndex}`;
            return (
              <div
                key={group.label}
                role="group"
                aria-labelledby={group.label ? headingId : undefined}
                className="suggestion-group"
              >
                {group.label && (
                  <div id={headingId} className="suggestion-group-heading">
                    {group.label}
                  </div>
                )}
                {items.map((option, offset) => {
                  const index = group.start + offset;
                  return (
                    <ComposerSuggestion
                      key={option.id}
                      option={option}
                      home={kind === "actions"}
                      id={`${listId}-${index}`}
                      selected={index === selectedIndex}
                      onHighlight={() => highlightOption(index)}
                      onChoose={() => choose(option)}
                    />
                  );
                })}
              </div>
            );
          })}
          {loading && !visible.length && !failed.length ? (
            <div className="suggestion-state" role="status">
              {t("common.loading")}
            </div>
          ) : failed.length ? (
            <div className="suggestion-state" role="alert">
              {t("composer.loadFailed")}{" "}
              <Button
                variant="ghost"
                size="sm"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => failed.forEach((item) => void item.refetch())}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : !visible.length ? (
            <Empty className="suggestion-state" role="status">
              {t(kind === "mention" ? "composer.noMentions" : "composer.empty")}
            </Empty>
          ) : null}
        </div>
        <div className="suggestion-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("composer.navigate")}
          </span>
          <span>
            <kbd>↵</kbd>
            <kbd>Tab</kbd> {t("composer.select")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("composer.dismiss")}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
