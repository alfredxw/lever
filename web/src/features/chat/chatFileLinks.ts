import type { Root, Scope } from "@/api/types.gen";
import {
  resolveWorkspaceFile,
  type FileLocation,
  type FileSelection,
} from "../files/filePaths.ts";

type ChatFileTarget = {
  path: string;
  fragment: string;
  location?: FileLocation;
};

export function chatPreviewURL(
  endpoint: string,
  kind: "image" | "html" | "visualization",
  path: string,
  fragment = "",
) {
  return `${endpoint}?${new URLSearchParams({ kind, path })}${fragment}`;
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
  const line = Number(suffix?.[1]);
  const column = Number(suffix?.[2]) || 1;
  const location =
    Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column)
      ? { line, column, endColumn: column }
      : undefined;
  return { path: value.replaceAll("\\", "/"), fragment, location };
}

// Relative links start in the session's working directory. Every editor link
// must resolve inside a root available to the Files panel.
export function resolveChatFileLink(
  href: string | undefined,
  scope: Scope,
  roots: Root[],
  origin: string,
): FileSelection | null {
  const target = chatFileTarget(href, origin);
  if (!target) return null;
  const primary = scope.roots.find((root) => root.id === scope.primaryRootId);
  const file = resolveWorkspaceFile(target.path, primary?.path, roots);
  return file && { ...file, location: target.location };
}
