import type {
  Catalog,
  PermissionInfo,
  PermissionSettings,
} from "@/api/types.gen";

export type AgentPermissionPolicy =
  | ""
  | "read_only"
  | "ask"
  | "auto"
  | "full_access";

export const AGENT_PERMISSION_POLICIES: readonly AgentPermissionPolicy[] = [
  "",
  "read_only",
  "ask",
  "auto",
  "full_access",
];

export function isCanonicalAgentPermissionPolicy(
  permission?: string,
): permission is AgentPermissionPolicy {
  return (
    !permission ||
    permission === "read_only" ||
    permission === "ask" ||
    permission === "auto" ||
    permission === "full_access"
  );
}

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

export function normalizeAgentPermissionPolicy(
  permission?: string,
): AgentPermissionPolicy {
  if (!permission) return "";
  switch (normalizePermissionKey(permission)) {
    case "read_only":
    case "plan":
    case "request_review":
      return "read_only";
    case "ask":
    case "default":
    case "dont_ask":
      return "ask";
    case "auto":
    case "auto_review":
    case "accept_edits":
    case "auto_edit":
    case "workspace_edit":
      return "auto";
    case "full_access":
    case "bypass_permissions":
    case "yolo":
    case "turbo":
      return "full_access";
    default:
      return "ask";
  }
}

function matchPermissionOptions(
  options: PermissionInfo[] | undefined,
  targets: readonly string[],
) {
  if (!options?.length) return undefined;
  for (const target of targets) {
    const match = options.find((option) =>
      option.mode
        ? option.mode === target
        : normalizePermissionKey(option.id) === target ||
          normalizePermissionKey(option.name) === target,
    );
    if (match) return match.id;
  }
  return undefined;
}

const readOnlyStrictModes = ["read_only", "plan", "request_review"] as const;
const askPolicyModes = ["ask", "request_review", "default"] as const;
const autoPolicyModes = [
  "auto",
  "auto_review",
  "accept_edits",
  "auto_edit",
  "workspace_edit",
] as const;
const fullAccessPolicyModes = [
  "full_access",
  "bypass_permissions",
  "yolo",
  "turbo",
  ...autoPolicyModes,
] as const;

export function resolveAgentPermissionForCatalog(
  profilePermission: string | undefined,
  catalog: Catalog | null | undefined,
  providerType?: string,
): string {
  if (!profilePermission) {
    return catalog?.defaultPermission ?? "";
  }
  if (!isCanonicalAgentPermissionPolicy(profilePermission)) {
    if (findPermission(catalog, profilePermission)) {
      return profilePermission;
    }
  }
  const policy = normalizeAgentPermissionPolicy(profilePermission);
  if (catalog) {
    if (policy === "read_only") {
      return (
        matchPermissionOptions(catalog.permissions, readOnlyStrictModes) ??
        matchPermissionOptions(catalog.legacyPermissions, readOnlyStrictModes) ??
        matchPermissionOptions(catalog.permissions, askPolicyModes) ??
        matchPermissionOptions(catalog.legacyPermissions, askPolicyModes) ??
        catalog.defaultPermission ??
        ""
      );
    }
    const targets =
      policy === "ask"
        ? askPolicyModes
        : policy === "full_access"
          ? fullAccessPolicyModes
          : autoPolicyModes;
    return (
      matchPermissionOptions(catalog.permissions, targets) ??
      matchPermissionOptions(catalog.legacyPermissions, targets) ??
      catalog.defaultPermission ??
      ""
    );
  }
  switch (policy) {
    case "read_only":
      if (providerType === "claude") return "plan";
      if (providerType === "pi") return "ask";
      if (providerType === "antigravity") return "request-review";
      return "read_only";
    case "ask":
      if (providerType === "antigravity") return "default";
      return "ask";
    case "auto":
      if (providerType === "codex") return "auto_review";
      if (providerType === "pi") return "accept_edits";
      return "auto";
    case "full_access":
      if (providerType === "antigravity") return "turbo";
      return "full_access";
    default:
      return "";
  }
}

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

const autoUnattendedPermissionModes = [
  "auto",
  "accept_edits",
  "workspace_edit",
  "full_access",
  "bypass_permissions",
];

const yoloUnattendedPermissionModes = [
  "full_access",
  "bypass_permissions",
  "auto",
  "accept_edits",
  "workspace_edit",
];

export function recommendedUnattendedPermission(
  catalog: Catalog | null | undefined,
  defaultMode: PermissionSettings["defaultMode"] = "auto",
): PermissionInfo | undefined {
  const options = catalog?.permissions ?? [];
  const modes =
    defaultMode === "yolo"
      ? yoloUnattendedPermissionModes
      : autoUnattendedPermissionModes;
  for (const mode of modes) {
    const match = options.find((option) => option.mode === mode);
    if (match) return match;
  }
  return options.find((option) => !isAskPermission(catalog, option.id));
}
