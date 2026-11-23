import type { FileMatch, Reference, Root } from "@/api/types.gen";

export type FileLocation = Pick<FileMatch, "line" | "column" | "endColumn">;
export type FileSelection = {
  root: Root;
  path: string;
  location?: FileLocation;
};
export type DirectorySelection = { root: Root; path: string };

export const isHomePath = (target: string) => /^~[\\/]/.test(target);
export const isAbsoluteHostPath = (target: string) =>
  /^(?:[a-z]:[\\/]|[\\/])/i.test(target);
export const isHostPath = (target: string) =>
  isHomePath(target) || isAbsoluteHostPath(target);

export function workspaceFilePath(target: string, cwd?: string): string | null {
  if (isHomePath(target)) {
    const parts: string[] = [];
    for (const part of target.replaceAll("\\", "/").slice(2).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    return parts.length ? `~/${parts.join("/")}` : "~";
  }
  const absolute = isAbsoluteHostPath(target);
  if (!absolute && !cwd) return null;
  const path = (absolute ? target : `${cwd}/${target}`).replaceAll("\\", "/");
  const drive = /^[a-z]:\//i.exec(path)?.[0].slice(0, 2) ?? "";
  const body = drive ? path.slice(2) : path;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  if (drive) return `${drive}/${parts.join("/")}`;
  return `${path.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

export function hostFileSelection(
  target: string,
  location?: FileLocation,
): FileSelection | null {
  if (
    !target ||
    /^[\\/]{2}/.test(target) ||
    /[\u0000-\u001f\u007f]/.test(target) ||
    !isHostPath(target)
  )
    return null;
  const normalized = workspaceFilePath(target);
  if (
    !normalized ||
    normalized === "/" ||
    normalized === "~" ||
    /^[a-z]:\/?$/i.test(normalized)
  )
    return null;
  const slash = normalized.lastIndexOf("/");
  if (slash < 0 || slash === normalized.length - 1) return null;
  const name = normalized.slice(slash + 1);
  if (!name || name === "." || name === "..") return null;
  const prefix = normalized.slice(0, slash);
  const dir =
    slash === 0 ? "/" : /^[a-z]:$/i.test(prefix) ? `${prefix}/` : prefix;
  return {
    root: { id: "host", path: dir },
    path: name,
    ...(location && { location }),
  };
}

// Resolve against the runtime cwd; an editor can open only paths in its Scope.
export function resolveWorkspaceFile(
  target: string,
  cwd: string | undefined,
  roots: Root[],
): DirectorySelection | null {
  const path = workspaceFilePath(target, cwd);
  if (!path) return null;
  const windows = /^[a-z]:\//i.test(path);
  const comparable = windows ? path.toLowerCase() : path;
  const candidates = roots
    .map((root) => ({ root, path: workspaceFilePath(root.path) }))
    .filter((item) => item.path !== null)
    .sort((a, b) => b.path!.length - a.path!.length);
  for (const candidate of candidates) {
    const rootPath = candidate.path!.replace(/\/$/, "");
    const prefix = `${windows ? rootPath.toLowerCase() : rootPath}/`;
    if (comparable.startsWith(prefix) && path.length > prefix.length)
      return { root: candidate.root, path: path.slice(prefix.length) };
  }
  return null;
}

// Markdown paths are URL-encoded and relative to the document, not the app.
// A leading slash starts at the scope root; traversal cannot leave that root.
export function resolveMarkdownPath(
  documentPath: string,
  target?: string,
): string | null {
  const value = target?.trim() ?? "";
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  )
    return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (!pathname || /[\\\u0000]/.test(pathname)) return null;
  const parts = pathname.startsWith("/")
    ? []
    : documentPath.split("/").slice(0, -1);
  for (const part of pathname.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : null;
}

export const rootName = (root: Root) =>
  root.path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || root.path;

export function absoluteFilePath({ root, path }: DirectorySelection) {
  const separator = root.path.includes("\\") ? "\\" : "/";
  return path === "."
    ? root.path
    : `${root.path.replace(/[\\/]+$/, "")}${separator}${path.replaceAll("/", separator)}`;
}

export function fileReference(target: DirectorySelection): Reference {
  return {
    kind: "file",
    name: target.path === "." ? rootName(target.root) : target.path,
    path: absoluteFilePath(target),
    description: target.root.path,
  };
}
