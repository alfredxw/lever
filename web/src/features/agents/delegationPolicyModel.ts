import type {
  DelegationPolicy,
  DelegationSettings,
  Profile,
} from "../../api/types.gen.ts";

export const defaultDelegationSettings: DelegationSettings = {
  defaultPolicy: "none",
};

export function effectiveDelegationPolicy(
  profile: Pick<Profile, "delegationPolicy" | "delegations">,
  defaults?: DelegationSettings,
): DelegationPolicy {
  if (
    profile.delegationPolicy === "none" ||
    profile.delegationPolicy === "all" ||
    profile.delegationPolicy === "selected"
  ) {
    return profile.delegationPolicy;
  }
  if ((profile.delegations?.length ?? 0) > 0) {
    return "selected";
  }
  if (defaults?.defaultPolicy === "all") {
    return "all";
  }
  return "none";
}

export function canAcceptDelegations(
  profile?: Pick<Profile, "acceptDelegations">,
): boolean {
  return profile?.acceptDelegations !== false;
}

export function allowsRemoteDelegation(
  profile?: Pick<Profile, "allowRemoteDelegation">,
): boolean {
  return profile?.allowRemoteDelegation !== false;
}

export function effectiveMaxDelegationDepth(
  profile?: Pick<Profile, "maxDelegationDepth">,
  defaults?: Pick<DelegationSettings, "maxDepth">,
): 1 | 2 {
  if (profile?.maxDelegationDepth === 2) return 2;
  if (profile?.maxDelegationDepth === 1) return 1;
  return defaults?.maxDepth === 2 ? 2 : 1;
}
