import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FileCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Root } from "@/api/types.gen";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FileTree } from "./FileTree";
import { rootName, type FileSelection } from "./filePaths";
export function FileToolbar({
  root,
  path,
  onFile,
  children,
}: {
  root?: Root;
  path?: string;
  onFile: (file: FileSelection) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const segments = path?.split("/") ?? [];
  const breadcrumb = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = breadcrumb.current!;
    const reveal = () => {
      element.scrollLeft = element.scrollWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [path]);
  return (
    <header className="file-bar">
      <nav
        className="file-breadcrumb"
        ref={breadcrumb}
        aria-label={t("files.path")}
        title={root ? `${root.path}${path ? `/${path}` : ""}` : undefined}
      >
        <ol>
          {root ? (
            <li>
              <PathSegment
                key={`${root.id}:${path}`}
                root={root}
                label={rootName(root)}
                directory="."
                selectedPath={path}
                current={!path}
                onFile={onFile}
              />
            </li>
          ) : (
            <li>
              <FileCode size={16} />
              <span>{t("workspace.files")}</span>
            </li>
          )}
          {segments.map((segment, index) => (
            <li key={index}>
              <ChevronRight size={14} aria-hidden="true" />
              {root && (
                <PathSegment
                  key={`${root.id}:${path}:${index}`}
                  root={root}
                  label={segment}
                  directory={segments.slice(0, index).join("/") || "."}
                  selectedPath={path}
                  current={index === segments.length - 1}
                  onFile={onFile}
                />
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="file-actions">{children}</div>
    </header>
  );
}

function PathSegment({
  root,
  label,
  directory,
  selectedPath,
  current,
  onFile,
}: {
  root: Root;
  label: string;
  directory: string;
  selectedPath?: string;
  current: boolean;
  onFile: (file: FileSelection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    const parts = selectedPath?.split("/").slice(0, -1) ?? [];
    return new Set(
      parts.map(
        (_, index) => `${root.id}:${parts.slice(0, index + 1).join("/")}`,
      ),
    );
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-current={current ? "page" : undefined}
          aria-label={t("files.browsePath", { name: label })}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(28rem,calc(100vw-24px))] p-1.5"
        aria-label={t("files.browsePath", { name: label })}
      >
        <div className="h-[min(60dvh,30rem)] min-h-20 overflow-hidden">
          <FileTree
            root={root}
            path={directory}
            selected={selectedPath ? { root, path: selectedPath } : undefined}
            expanded={expanded}
            onExpandedChange={(key, open) =>
              setExpanded((old) => {
                const next = new Set(old);
                if (open) next.add(key);
                else next.delete(key);
                return next;
              })
            }
            onFile={(file) => {
              setOpen(false);
              onFile(file);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
