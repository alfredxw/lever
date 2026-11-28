import { queryOptions, skipToken } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "@/api/client";
import {
  SkillEntry,
  type FileEntry,
  type FileSearch,
  type Root,
} from "@/api/types.gen";
import { scopeParams } from "@/features/worktrees/scope";

export { SkillEntry as skillEntry };
export type ReferenceScope = {
  sessionId?: string;
  workingCopyId?: string;
};
export type AgentFileSource = { kind: "agent"; id: string; nodeId?: string; readOnly?: boolean } & ReferenceScope;
export type SkillFileSource = {
  kind: "skill";
  id: string;
  readOnly: boolean;
  scope?: ReferenceScope & { agentId: string };
};
export type HostFileSource = {
  kind: "host";
  id: "host";
  readOnly: true;
};
export const hostFileSource: HostFileSource = {
  kind: "host",
  id: "host",
  readOnly: true,
};
export type FileSource = AgentFileSource | SkillFileSource | HostFileSource;

export const FileSourceContext = createContext<FileSource | null>(null);

export function useFileSource() {
  const source = useContext(FileSourceContext);
  if (!source) throw new Error("Files requires a file source");
  return source;
}

export const fileReadOnly = (source: FileSource) =>
  source.kind === "host" || !!source.readOnly;

export const isSkillEntry = (source: FileSource, path: string) =>
  source.kind === "skill" && path.toLowerCase() === SkillEntry.toLowerCase();

export function fileSourceKey(source: FileSource) {
  if (source.kind === "host") return "/host-file";
  const owner = source.kind === "agent" && source.nodeId
    ? "/nodes/" + encodeURIComponent(source.nodeId)
    : "";
  const collection = source.kind === "agent" ? "agents" : "skills";
  return `${owner}/${collection}/${encodeURIComponent(source.id)}`;
}

export function fileScopeKey(source: FileSource) {
  if (source.kind !== "agent") return;
  if (source.sessionId) return source.sessionId;
  if (source.workingCopyId) return `working-copy:${source.workingCopyId}`;
}

export function fileEndpoint(
  source: FileSource,
  route: "file" | "files" | "files/search" | "files/operation",
  params: Record<string, string>,
) {
  const skillScope = source.kind === "skill" ? source.scope : undefined;
  const scope = source.kind === "agent" ? source : skillScope;
  const query = new URLSearchParams({
    ...params,
    ...(skillScope && { agentId: skillScope.agentId }),
    ...scopeParams(scope?.sessionId, scope?.workingCopyId),
  });
  return `${fileSourceKey(source)}/${route}?${query}`;
}

export function fileSearchQuery(
  source: FileSource | undefined,
  roots: Root[] | undefined,
  mode: "path" | "content",
  query: string,
  root?: string,
) {
  return queryOptions({
    queryKey: [
      "file-search",
      source && fileSourceKey(source),
      roots,
      source && fileScopeKey(source),
      mode,
      root,
      query,
    ],
    queryFn: source
      ? ({ signal }) =>
          api<FileSearch>(
            fileEndpoint(source, "files/search", {
              mode,
              query,
              ...(root ? { root } : {}),
            }),
            undefined,
            "GET",
            signal,
          )
      : skipToken,
  });
}

export const fileEntriesQuery = (source: FileSource, root: Root, path = ".") =>
  queryOptions({
    queryKey: [
      "files",
      fileSourceKey(source),
      root.id,
      root.path,
      path,
      fileScopeKey(source),
    ],
    queryFn: ({ signal }) =>
      api<FileEntry[]>(
        fileEndpoint(source, "files", { root: root.id, path }),
        undefined,
        "GET",
        signal,
      ),
  });
