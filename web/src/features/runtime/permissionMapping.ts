import type { Catalog, Selection } from "@/api/types.gen";
import { useModels } from "./queries";

export type PermissionSource = Pick<Selection, "provider" | "permission">;

export function findPermission(
  catalog: Catalog | null | undefined,
  id?: string,
) {
  return (
    catalog?.permissions.find((option) => option.id === id) ??
    catalog?.legacyPermissions?.find((option) => option.id === id)
  );
}

export function usePermissionMapping(
  source: PermissionSource | undefined,
  provider: string,
  cwd: string,
  catalog: Catalog | null | undefined,
) {
  const sameProvider = source?.provider === provider;
  const original = useModels(
    source?.provider ?? "",
    cwd,
    !!source && !sameProvider,
  );
  const from = sameProvider ? catalog : original.data;
  const id = source?.permission || from?.defaultPermission;
  const mode = findPermission(from, id)?.mode;
  const options = catalog?.permissions;
  const permission = sameProvider
    ? findPermission(catalog, id)?.id
    : mode
      ? (
          options?.find((option) => option.mode === mode) ??
          options?.find((option) => option.mode === "ask")
        )?.id
      : undefined;
  return {
    permission,
    pending:
      !!source &&
      ((!sameProvider && original.isPending) ||
        (!catalog && !!(sameProvider ? id : mode))),
  };
}
