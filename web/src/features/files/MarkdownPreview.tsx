import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  defaultRehypePlugins,
  type Components,
  type StreamdownProps,
} from "streamdown";
import type { Root } from "@/api/types.gen";
import { CodeSnippet } from "@/components/ai-elements/code-block";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { Button } from "@/components/ui/button";
import { chatFileTarget } from "@/features/chat/chatFileLinks";
import { fileURL } from "./fileDrafts";
import {
  absoluteFilePath,
  hostFileSelection,
  isHomePath,
  isHostPath,
  resolveMarkdownPath,
  resolveWorkspaceFile,
  workspaceFilePath,
  type FileSelection,
} from "./filePaths";
import {
  hostFileSource,
  useFileSource,
  type HostFileSource,
  type SkillFileSource,
} from "./fileSource";

type ExternalFileSelection = FileSelection & {
  source?: SkillFileSource | HostFileSource;
};

type MarkdownNode = {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
};

const urlProperty: Record<string, string | undefined> = {
  a: "href",
  img: "src",
  source: "srcSet",
};

// Preserve Windows drive paths as file: URLs so sanitization does not mistake
// the drive letter for an unknown protocol.
function windowsDriveURLs() {
  function visit(node: MarkdownNode) {
    const key = node.tagName && urlProperty[node.tagName];
    const value = key && node.properties?.[key];
    if (
      key &&
      typeof value === "string" &&
      /^[a-z]:[\\/]/i.test(value) &&
      node.properties
    ) {
      node.properties[key] =
        "file:///" +
        value
          .replaceAll("\\", "/")
          .split("/")
          .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
          .join("/");
    }
    node.children?.forEach(visit);
  }
  return visit;
}

type SanitizeTuple = [
  unknown,
  { protocols?: Record<string, string[]> } | undefined,
];

function createMarkdownSanitize() {
  const base = defaultRehypePlugins.sanitize;
  if (!Array.isArray(base)) return base;
  const [plugin, schema] = base as SanitizeTuple;
  return [
    plugin,
    {
      ...schema,
      protocols: {
        ...schema?.protocols,
        href: [...(schema?.protocols?.href ?? []), "file", "sandbox"],
        src: [...(schema?.protocols?.src ?? []), "file", "sandbox"],
      },
    },
  ];
}

// Keep raw HTML parsing and sanitization, while preserving file:/sandbox: URLs
// for our own link and image renderers (which never expose raw file: to the DOM).
const rehypePlugins = [
  defaultRehypePlugins.raw,
  windowsDriveURLs,
  createMarkdownSanitize(),
] as NonNullable<StreamdownProps["rehypePlugins"]>;

const carouselSeparator = /^\s*<!--\s*slide\s*-->\s*$/im;

function documentDirectory(root: Root, path: string) {
  const full = absoluteFilePath({ root, path }).replaceAll("\\", "/");
  const slash = full.lastIndexOf("/");
  if (slash === 0) return "/";
  if (slash > 0) {
    const prefix = full.slice(0, slash);
    return /^[a-z]:$/i.test(prefix) ? `${prefix}/` : prefix;
  }
  return root.path;
}

function hostImageURL(path: string, fragment = "") {
  return `/api/host-file?${new URLSearchParams({ path, asset: "true" })}${fragment}`;
}

export function MarkdownPreview({
  file: { root, path },
  text,
  workspaceRoots,
  onFile,
  onOpenExternalFile,
}: {
  file: FileSelection;
  text: string;
  workspaceRoots?: Root[];
  onFile: (file: FileSelection) => void;
  onOpenExternalFile?: (file: ExternalFileSelection) => void;
}) {
  return (
    <MarkdownDocument
      root={root}
      path={path}
      text={text}
      workspaceRoots={workspaceRoots}
      onFile={onFile}
      onOpenExternalFile={onOpenExternalFile}
      allowCarousel
    />
  );
}

function MarkdownDocument({
  root,
  path,
  text,
  workspaceRoots,
  onFile,
  onOpenExternalFile,
  allowCarousel,
}: {
  root: Root;
  path: string;
  text: string;
  workspaceRoots?: Root[];
  onFile: (file: FileSelection) => void;
  onOpenExternalFile?: (file: ExternalFileSelection) => void;
  allowCarousel: boolean;
}) {
  const fileSource = useFileSource();
  const components = useMemo<Components>(() => {
    const host = fileSource.kind === "host";
    const docDir = documentDirectory(root, path);
    const origin = window.location.origin;
    const isExplicitLocalScheme = (value: string) =>
      /^(?:file:|sandbox:|[a-z]:[\\/])/i.test(value.trim());

    const imageURL = (src?: string) => {
      if (!src) return;
      if (src.startsWith("//")) return `https:${src}`;
      if (/^https?:\/\//i.test(src)) return src;
      if (host) {
        const target = chatFileTarget(src, origin);
        if (!target) return;
        const resolved = workspaceFilePath(target.path, docDir);
        if (resolved && isHostPath(resolved))
          return hostImageURL(resolved, target.fragment);
        return;
      }
      if (!isHomePath(src) && !isExplicitLocalScheme(src)) {
        const local = resolveMarkdownPath(path, src);
        if (local) {
          const fragment = src.match(/#.*$/)?.[0] ?? "";
          return `/api${fileURL({ source: fileSource, root, path: local })}&asset=true${fragment}`;
        }
      }
      const target = chatFileTarget(src, origin);
      if (!target) return;
      const resolved = workspaceFilePath(target.path, docDir);
      if (!resolved) return;
      const inside = resolveWorkspaceFile(resolved, undefined, [root]);
      if (inside) {
        return `/api${fileURL({ source: fileSource, root: inside.root, path: inside.path })}&asset=true${target.fragment}`;
      }
      if (isHostPath(resolved)) return hostImageURL(resolved, target.fragment);
    };

    const resolveLink = (
      href?: string,
    ): {
      file: ExternalFileSelection;
      external: boolean;
    } | null => {
      if (!href || href.startsWith("#")) return null;
      const explicitScheme = isExplicitLocalScheme(href);
      if (!host && !isHomePath(href) && !explicitScheme) {
        const local = resolveMarkdownPath(path, href);
        if (local) return { file: { root, path: local }, external: false };
      }
      const target = chatFileTarget(href, origin);
      if (!target) return null;
      const resolved = workspaceFilePath(target.path, docDir);
      if (!resolved) return null;
      if (!host) {
        const sameRoot = resolveWorkspaceFile(resolved, undefined, [root]);
        if (sameRoot) {
          return {
            file: { ...sameRoot, location: target.location },
            external: false,
          };
        }
      }
      const knownRoots = workspaceRoots?.length
        ? workspaceRoots
        : host
          ? []
          : [root];
      const workspace = resolveWorkspaceFile(resolved, undefined, knownRoots);
      if (workspace) {
        return {
          file: { ...workspace, location: target.location },
          external: host || workspace.root.id !== root.id,
        };
      }
      const hostFile = hostFileSelection(resolved, target.location);
      if (hostFile) {
        return {
          file: { ...hostFile, source: hostFileSource },
          external: !host,
        };
      }
      return null;
    };

    return {
      code: ({ children, className }) => {
        const code = String(children ?? "");
        const language = className?.replace(/^language-/, "") || "text";
        if (allowCarousel && language.toLowerCase() === "carousel") {
          const slides = code
            .split(carouselSeparator)
            .map((slide) => slide.trim())
            .filter(Boolean);
          if (slides.length > 0) {
            return (
              <MarkdownCarousel
                slides={slides}
                root={root}
                path={path}
                workspaceRoots={workspaceRoots}
                onFile={onFile}
                onOpenExternalFile={onOpenExternalFile}
              />
            );
          }
        }
        return language.toLowerCase() === "mermaid" ? (
          <MermaidBlock code={code} />
        ) : (
          <CodeSnippet code={code} language={language} />
        );
      },
      // Preserve HTML paragraph attributes, including image alignment.
      p: ({ node: _node, ...props }) => <p {...props} />,
      img: ({ src, alt, node: _node, ...props }) => {
        const source = imageURL(src);
        return source ? (
          <img
            {...props}
            src={source}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="text-muted-foreground">{alt}</span>
        );
      },
      source: ({ srcSet, media }) => {
        // A single <picture> variant (such as a dark logo) is a normal image
        // reference. Other srcsets fall back to <img> rather than the app URL.
        const candidate = srcSet?.trim();
        const source =
          candidate && /^\S+$/.test(candidate) && imageURL(candidate);
        return source ? <source media={media} srcSet={source} /> : null;
      },
      a: ({ href, children, node: _node, ...props }) => {
        const resolved = resolveLink(href);
        if (resolved) {
          const canOpen = !resolved.external || !!onOpenExternalFile;
          if (canOpen) {
            const fullPath = absoluteFilePath(resolved.file);
            return (
              <a
                {...props}
                href={href}
                title={fullPath}
                onClick={(event) => {
                  event.preventDefault();
                  if (resolved.external && onOpenExternalFile) {
                    onOpenExternalFile(resolved.file);
                  } else {
                    onFile(resolved.file);
                  }
                }}
              >
                {children}
              </a>
            );
          }
        }
        if (href?.startsWith("#")) {
          return (
            <a {...props} href={href}>
              {children}
            </a>
          );
        }
        return href && /^(?:https?:|mailto:|tel:|\/\/)/i.test(href) ? (
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        );
      },
    };
  }, [
    allowCarousel,
    fileSource,
    root,
    path,
    workspaceRoots,
    onFile,
    onOpenExternalFile,
  ]);

  return (
    <MessageResponse
      text={text}
      components={components}
      rehypePlugins={rehypePlugins}
    />
  );
}

function MarkdownCarousel({
  slides,
  root,
  path,
  workspaceRoots,
  onFile,
  onOpenExternalFile,
}: {
  slides: string[];
  root: Root;
  path: string;
  workspaceRoots?: Root[];
  onFile: (file: FileSelection) => void;
  onOpenExternalFile?: (file: ExternalFileSelection) => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const current = Math.min(index, slides.length - 1);
  return (
    <div className="file-markdown-carousel">
      <div className="file-markdown-carousel-slide">
        <MarkdownDocument
          root={root}
          path={path}
          text={slides[current]}
          workspaceRoots={workspaceRoots}
          onFile={onFile}
          onOpenExternalFile={onOpenExternalFile}
          allowCarousel={false}
        />
      </div>
      {slides.length > 1 && (
        <div className="file-markdown-carousel-bar">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("files.previousPage")}
            disabled={current === 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular-nums text-xs text-muted-foreground">
            {current + 1} / {slides.length}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("files.nextPage")}
            disabled={current === slides.length - 1}
            onClick={() =>
              setIndex((value) => Math.min(slides.length - 1, value + 1))
            }
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
