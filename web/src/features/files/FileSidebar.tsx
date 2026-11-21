import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, useIsFetching } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ChevronsDownUp,
  FilePlus2,
  FolderPlus,
  Folder,
  RefreshCw,
  FileCode,
  Search,
  X,
} from "lucide-react";
import type { Scope, FileMatch } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import { FileTree } from "./FileTree";
import {
  rootName,
  type FileSelection,
  type DirectorySelection,
} from "./filePaths";

import { ToolbarButton } from "@/components/ui/toolbar-button";
import { SearchHighlight } from "@/components/ui/search-highlight";
import { relocateEntry, useEntryChanges } from "./fileOperations";
import {
  fileReadOnly,
  fileSearchQuery,
  fileSourceKey,
  useFileSource,
} from "./fileSource";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function FileSidebar({
  scope,
  mode,
  hidden,
  selected,
  directory,
  onFile,
}: {
  scope: Scope;
  mode: "path" | "content";
  hidden: boolean;
  selected?: FileSelection;
  directory?: DirectorySelection;
  onFile: (file: FileSelection) => void;
}) {
  const { t } = useTranslation();
  const source = useFileSource();
  const sourceKey = fileSourceKey(source);
  const [queries, setQueries] = useState({ path: "", content: "" });
  const input = queries[mode];
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "content" && !hidden) searchInput.current?.focus();
  }, [mode, hidden]);
  const [debounced, setDebounced] = useState({ mode, query: "" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const client = useQueryClient();
  const [target, setTarget] = useState<DirectorySelection | undefined>(
    directory,
  );
  useEntryChanges((change) =>
    setTarget((current) => relocateEntry(current, change)),
  );
  const [creating, setCreating] = useState<{
    target: DirectorySelection;
    directory: boolean;
  }>();
  const root =
    scope.roots.find(
      (root) => root.id === target?.root.id && root.path === target.root.path,
    ) ??
    scope.roots.find((root) => root.id === scope.primaryRootId) ??
    scope.roots[0];
  const fetching = useIsFetching({ queryKey: ["files", sourceKey, root?.id] });
  const destination = root && {
    root,
    path:
      target?.root.id === root.id && target.root.path === root.path
        ? target.path
        : ".",
  };
  const revealDirectory = (next: DirectorySelection) => {
    setTarget(next);
    setQueries((old) => ({ ...old, path: "" }));
    setExpanded((old) => {
      const expanded = new Set(old);
      const parts = next.path === "." ? [] : next.path.split("/");
      parts.forEach((_, index) =>
        expanded.add(`${next.root.id}:${parts.slice(0, index + 1).join("/")}`),
      );
      return expanded;
    });
  };
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ mode, query: input }), 250);
    return () => clearTimeout(timer);
  }, [input, mode]);
  useEffect(() => {
    if (!directory) return;
    revealDirectory(directory);
  }, [directory]);
  const query = useQuery({
    ...fileSearchQuery(
      source,
      scope.roots,
      mode,
      debounced.query,
      mode === "path" ? root?.id : undefined,
    ),
    enabled:
      !hidden &&
      !!input &&
      input === debounced.query &&
      mode === debounced.mode,
  });
  const pending =
    !!input &&
    (input !== debounced.query || mode !== debounced.mode || query.isFetching);
  const matches = !input || pending ? [] : (query.data?.matches ?? []);
  const groups = new Map<string, FileMatch[]>();
  for (const match of matches) {
    const key = `${match.rootId}:${match.path}`;
    const group = groups.get(key) ?? [];
    group.push(match);
    groups.set(key, group);
  }
  return (
    <aside
      className="file-sidebar"
      hidden={hidden}
      aria-label={t(mode === "content" ? "files.search" : "files.directory")}
    >
      <div className="file-sidebar-heading">
        <span>{t(mode === "content" ? "files.search" : "files.allFiles")}</span>
        {mode === "path" && (
          <div className="file-actions">
            {!fileReadOnly(source) && (
              <>
                <ToolbarButton
                  label={t("files.newFile")}
                  disabled={!destination}
                  onClick={() => {
                    setQueries((old) => ({ ...old, path: "" }));
                    if (destination)
                      setCreating({ target: destination, directory: false });
                  }}
                >
                  <FilePlus2 />
                </ToolbarButton>
                <ToolbarButton
                  label={t("files.newFolder")}
                  disabled={!destination}
                  onClick={() => {
                    setQueries((old) => ({ ...old, path: "" }));
                    if (destination)
                      setCreating({ target: destination, directory: true });
                  }}
                >
                  <FolderPlus />
                </ToolbarButton>
              </>
            )}
            <ToolbarButton
              label={t("files.refreshTree")}
              disabled={!!fetching}
              onClick={() => {
                void client.invalidateQueries({
                  queryKey: ["files", sourceKey, root?.id],
                });
                void client.invalidateQueries({
                  queryKey: ["file-search", sourceKey],
                });
              }}
            >
              <RefreshCw className={fetching ? "animate-spin" : ""} />
            </ToolbarButton>
            <ToolbarButton
              label={t("files.collapseAll")}
              onClick={() => {
                setExpanded(
                  (old) =>
                    new Set(
                      Array.from(old).filter(
                        (key) => !key.startsWith(`${root?.id}:`),
                      ),
                    ),
                );
                setQueries((old) => ({ ...old, path: "" }));
                setTarget(root ? { root, path: "." } : undefined);
              }}
            >
              <ChevronsDownUp />
            </ToolbarButton>
          </div>
        )}
      </div>
      {mode === "path" && root && scope.roots.length > 1 && (
        <div className="file-root-picker">
          <Select
            value={root.id}
            onValueChange={(id) => {
              const next = scope.roots.find((root) => root.id === id);
              if (next) setTarget({ root: next, path: "." });
            }}
          >
            <SelectTrigger aria-label={t("files.scopeRoot")} title={root.path}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scope.roots.map((root) => (
                <SelectItem key={root.id} value={root.id}>
                  <Folder className="size-4" />
                  {rootName(root)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="file-search-input">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            key={mode}
            ref={searchInput}
            autoFocus={mode === "content" && !hidden}
            aria-label={t(mode === "content" ? "files.search" : "files.filter")}
            placeholder={t(
              mode === "content" ? "files.searchPlaceholder" : "files.filter",
            )}
            value={input}
            onChange={(event) =>
              setQueries((old) => ({ ...old, [mode]: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === "Escape")
                setQueries((old) => ({ ...old, [mode]: "" }));
            }}
          />
          {input && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={t("files.clearSearch")}
                onClick={() => setQueries((old) => ({ ...old, [mode]: "" }))}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <div className="file-sidebar-scroll">
        {mode === "path" && !input ? (
          root && (
            <FileTree
              key={`${root.id}:${root.path}`}
              root={root}
              creation={creating}
              onCreationStarted={() => setCreating(undefined)}
              onFile={onFile}
              onDirectory={setTarget}
              selected={selected}
              expanded={expanded}
              onExpandedChange={(key, open) =>
                setExpanded((old) => {
                  const next = new Set(old);
                  if (open) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
            />
          )
        ) : (
          <>
            <div className="file-search-summary" role="status">
              {!input
                ? t("files.searchHint")
                : pending
                  ? t("files.searching")
                  : query.error
                    ? null
                    : matches.length
                      ? t(
                          mode === "content"
                            ? "files.results"
                            : "files.filtered",
                          {
                            count: matches.length,
                            files: groups.size,
                          },
                        )
                      : t("files.noResults")}
            </div>
            {input && !pending && query.error && (
              <ErrorNotice
                error={query.error}
                retry={() => void query.refetch()}
              />
            )}
            {Array.from(groups, ([key, group]) => {
              const first = group[0];
              const root = scope.roots.find(
                (entry) => entry.id === first.rootId,
              );
              if (!root) return null;
              const fileName = first.path.split("/").pop();
              return (
                <section className="file-search-group" key={key}>
                  <button
                    className="file-result-path"
                    title={`${root.path}/${first.path}`}
                    onClick={() =>
                      onFile({
                        root,
                        path: first.path,
                        location: first.line ? first : undefined,
                      })
                    }
                  >
                    <FileCode size={15} />
                    <span>
                      <strong>{fileName}</strong>
                      <small>
                        {rootName(root)} /{" "}
                        {first.path.includes("/")
                          ? first.path.slice(0, first.path.lastIndexOf("/"))
                          : ""}
                      </small>
                    </span>
                    {mode === "content" && (
                      <span className="file-match-count">{group.length}</span>
                    )}
                  </button>
                  {mode === "content" &&
                    group.map((match) => (
                      <button
                        className="file-result-line"
                        key={match.line}
                        onClick={() =>
                          onFile({
                            root,
                            path: match.path,
                            location: { ...match },
                          })
                        }
                        title={`${match.path}:${match.line}\n${match.text}`}
                      >
                        <span>{match.line}</span>
                        <code>
                          <SearchHighlight
                            text={match.text}
                            query={debounced.query}
                          />
                        </code>
                      </button>
                    ))}
                </section>
              );
            })}
            {input && !pending && query.data?.truncated && (
              <p className="file-search-summary">{t("files.resultsLimited")}</p>
            )}
          </>
        )}
      </div>
      {mode === "content" && (
        <p className="file-search-footnote">{t("files.searchScope")}</p>
      )}
    </aside>
  );
}
