import type { Root, Scope } from "@/api/types.gen";
import {
  hostFileSelection,
  resolveWorkspaceFile,
  workspaceFilePath,
  type FileLocation,
  type FileSelection,
} from "../files/filePaths.ts";

const lineFragment = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i;

type ChatFileTarget = {
  path: string;
  fragment: string;
  location?: FileLocation;
};

export type HtmlPreview = { src: string; title: string };

export function chatPreviewURL(
  endpoint: string,
  kind: "image" | "html" | "visualization",
  path: string,
  fragment = "",
) {
  return `${endpoint}?${new URLSearchParams({ kind, path })}${fragment}`;
}

export function htmlViewerURL(src: string) {
  return src.replace(/^\/api\//, "/view/");
}

export function parseHtmlPreviewURL(
  href: string,
  origin: string,
): HtmlPreview | null {
  if (!/^(?:https?:\/\/|\/(?:api|view)\/)/i.test(href)) return null;
  try {
    const url = new URL(href, origin);
    const endpoint = url.pathname.replace(/^\/view\//, "/api/");
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !/^\/api\/(?:(?:runs|attachments)\/[^/]+|shared-conversations\/[^/]+\/[^/]+)\/preview$/.test(
        endpoint,
      )
    )
      return null;
    const kind = url.searchParams.get("kind");
    const path = url.searchParams.get("path");
    if (
      (kind !== "html" && kind !== "visualization") ||
      !path ||
      (endpoint.startsWith("/api/attachments/") &&
        (kind !== "html" || /[\\/]/.test(path))) ||
      path.length > 4096 ||
      !/\.html?$/i.test(path)
    )
      return null;
    return {
      src: chatPreviewURL(endpoint, kind, path, url.hash),
      title: path.split(/[\\/]/).at(-1)!,
    };
  } catch {
    return null;
  }
}

export function chatHtmlPreview(
  href: string,
  endpoint: string | undefined,
  origin: string,
) {
  const explicit = parseHtmlPreviewURL(href, origin);
  if (explicit || !endpoint) return explicit;
  const target = chatFileTarget(href, origin);
  if (!target || target.location || !/\.html?$/i.test(target.path)) return null;
  return {
    src: chatPreviewURL(endpoint, "html", target.path, target.fragment),
    title: target.path.split("/").at(-1)!,
  };
}

export function chatFileTarget(
  target: string | undefined,
  origin: string,
): ChatFileTarget | null {
  let value = target?.trim() ?? "";
  if (!value || /^[?#]/.test(value) || value.startsWith("//")) return null;
  const fragment = value.match(/#.*$/)?.[0] ?? "";
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1].toLowerCase();
  const isURL =
    scheme === "file" ||
    scheme === "sandbox" ||
    scheme === "http" ||
    scheme === "https";
  if (isURL) {
    try {
      const url = new URL(value);
      if (url.protocol === "sandbox:") {
        if (url.host || !url.pathname.startsWith("/")) return null;
      } else if (url.protocol === "file:") {
        if (url.hostname && url.hostname !== "localhost") return null;
      } else if (url.origin !== origin) return null;
      value = url.pathname;
    } catch {
      return null;
    }
  }
  try {
    value = decodeURIComponent(value.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (isURL) value = value.replace(/^\/([a-z]:\/)/i, "$1");
  const suffix = /:(\d+)(?::(\d+))?(?:-\d+(?::\d+)?)?$/.exec(value);
  if (suffix) value = value.slice(0, suffix.index);
  if (!value || /^[\\/]{2}/.test(value) || /[\u0000-\u001f\u007f]/.test(value))
    return null;
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(value);
  // Check the scheme after removing the line suffix in links like main.go:20.
  if (!absolute && scheme && value.includes(":")) return null;
  const hashLine = !suffix ? lineFragment.exec(fragment) : null;
  const line = Number(suffix?.[1] ?? hashLine?.[1]);
  const column = Number(suffix?.[2] ?? hashLine?.[2]) || 1;
  const location =
    Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column)
      ? { line, column, endColumn: column }
      : undefined;
  return {
    path: value.replaceAll("\\", "/"),
    fragment: hashLine && location ? "" : fragment,
    location,
  };
}

export type ResolvedChatFile = {
  file: FileSelection;
  host: boolean;
};

// Relative links start in the session's working directory. Files inside a root
// available to the Files panel open in workspace mode; other host files open
// in read-only host preview mode.
export function resolveChatFile(
  href: string | undefined,
  scope: Scope | undefined,
  roots: Root[],
  origin: string,
  cwd?: string,
): ResolvedChatFile | null {
  const target = chatFileTarget(href, origin);
  if (!target) return null;
  const primary =
    cwd ?? scope?.roots.find((root) => root.id === scope.primaryRootId)?.path;
  const workspace = resolveWorkspaceFile(target.path, primary, roots);
  if (workspace) {
    return {
      file: { ...workspace, location: target.location },
      host: false,
    };
  }
  const resolved = workspaceFilePath(target.path, primary);
  const host = resolved ? hostFileSelection(resolved, target.location) : null;
  return host ? { file: host, host: true } : null;
}

// Relative links start in the session's working directory. Every editor link
// must resolve inside a root available to the Files panel.
export function resolveChatFileLink(
  href: string | undefined,
  scope: Scope,
  roots: Root[],
  origin: string,
): FileSelection | null {
  const resolved = resolveChatFile(href, scope, roots, origin);
  return resolved && !resolved.host ? resolved.file : null;
}
