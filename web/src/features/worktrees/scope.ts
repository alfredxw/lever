import { createContext } from "react";
import type { Scope } from "@/api/types.gen";

export const WorkspaceSession = createContext<string | undefined>(undefined);

export function scopeParams(
  sessionId?: string,
  workingCopyId?: string,
): Record<string, string> {
  if (sessionId) return { sessionId };
  return workingCopyId ? { workingCopyId } : {};
}

export function primaryDirectory(scope: Scope): string {
  return (
    scope.roots.find((root) => root.id === scope.primaryRootId)?.path ?? ""
  );
}
