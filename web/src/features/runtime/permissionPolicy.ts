import type { Catalog, PermissionInfo } from "@/api/types.gen";

export function findPermission(
  catalog: Catalog | null | undefined,
  id?: string,
) {
  return (
    catalog?.permissions.find((option) => option.id === id) ??
    catalog?.legacyPermissions?.find((option) => option.id === id)
  );
}

const normalizePermissionKey = (text: string) =>
  text.toLowerCase().replace(/[\s-]+/g, "_");

export function isAskPermission(
  catalog: Catalog | null | undefined,
  permission?: string,
): boolean {
  const id = permission || catalog?.defaultPermission || "";
  if (!id) return false;
  const option = findPermission(catalog, id);
  if (option?.mode) {
    return option.mode === "ask" || option.mode === "request_review";
  }
  if (option) {
    const keyId = normalizePermissionKey(option.id);
    const keyName = normalizePermissionKey(option.name);
    return (
      keyId === "ask" ||
      keyId === "request_review" ||
      keyName === "ask" ||
      keyName === "request_review"
    );
  }
  const key = normalizePermissionKey(id);
  return key === "ask" || key === "request_review";
}

const unattendedPermissionModes = [
  "auto",
  "accept_edits",
  "workspace_edit",
  "full_access",
  "bypass_permissions",
];

export function recommendedUnattendedPermission(
  catalog: Catalog | null | undefined,
): PermissionInfo | undefined {
  const options = catalog?.permissions ?? [];
  for (const mode of unattendedPermissionModes) {
    const match = options.find((option) => option.mode === mode);
    if (match) return match;
  }
  return options.find((option) => !isAskPermission(catalog, option.id));
}
