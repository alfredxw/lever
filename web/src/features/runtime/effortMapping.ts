import type { ModelInfo } from "@/api/types.gen";

export type EffortSource = {
  effort: string;
  efforts?: readonly string[];
};

const offEfforts = new Set(["off", "none"]);
const superEfforts = new Set(["ultra"]);
const defaultEfforts = new Set(["default"]);
const standardRank = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function normalizeEffortKey(value: string): string {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (key === "extrahigh") return "xhigh";
  return key;
}

function isOff(value: string): boolean {
  return offEfforts.has(normalizeEffortKey(value));
}

function isSuper(value: string): boolean {
  return superEfforts.has(normalizeEffortKey(value));
}

function isDefaultOption(value: string): boolean {
  return defaultEfforts.has(normalizeEffortKey(value));
}

function rankOf(value: string): number {
  return standardRank.indexOf(
    normalizeEffortKey(value) as (typeof standardRank)[number],
  );
}

// Standard single-agent effort scale ordered from lowest to highest, excluding
// explicit off/none switches, runtime-default placeholders, and multi-agent ultra.
function standardScale(efforts: readonly string[]): string[] {
  const items = efforts.filter(
    (effort) => !isOff(effort) && !isSuper(effort) && !isDefaultOption(effort),
  );
  if (items.length > 1 && items.every((effort) => rankOf(effort) >= 0)) {
    return [...items].sort((a, b) => rankOf(a) - rankOf(b));
  }
  return items;
}

export function isMeaningfulEffortSource(
  effort: string,
  efforts?: readonly string[],
): boolean {
  if (!effort) return false;
  if (isOff(effort) || isSuper(effort)) return true;
  if (!efforts || efforts.length === 0) return true;
  return efforts.length >= 2;
}

/**
 * Maps a user's current effort habit onto a target model's effort scale.
 *
 * Models name their highest single-agent reasoning tier differently (e.g.
 * Carbon tops out at `high`, Neon at `xhigh`, GPT/Opus at `max` with multi-agent
 * `ultra` kept separate above the standard ceiling). Switching from a model's
 * standard ceiling therefore maps to the target model's standard ceiling rather
 * than matching literally by name.
 */
export function resolveEffort(
  source: EffortSource | string | undefined,
  target: Pick<ModelInfo, "efforts" | "defaultEffort">,
): string {
  if (!target.efforts.length) return "";
  const sourceEffort =
    typeof source === "string" ? source : (source?.effort ?? "");
  const sourceEfforts =
    typeof source === "string" ? undefined : source?.efforts;
  if (!sourceEffort) return target.defaultEffort;

  const sourceKey = normalizeEffortKey(sourceEffort);
  const targetStandard = standardScale(target.efforts);
  const targetCeiling =
    targetStandard[targetStandard.length - 1] ??
    target.efforts[target.efforts.length - 1];

  if (isDefaultOption(sourceEffort)) {
    return target.efforts.find(isDefaultOption) ?? target.defaultEffort;
  }

  if (isOff(sourceEffort)) {
    const exact = target.efforts.find(
      (effort) => normalizeEffortKey(effort) === sourceKey,
    );
    if (exact) return exact;
    const anyOff = target.efforts.find(isOff);
    if (anyOff) return anyOff;
    return targetStandard[0] ?? target.efforts[0];
  }

  if (isSuper(sourceEffort)) {
    const exact = target.efforts.find(
      (effort) => normalizeEffortKey(effort) === sourceKey,
    );
    if (exact) return exact;
    const anySuper = target.efforts.find(isSuper);
    if (anySuper) return anySuper;
    return targetCeiling;
  }

  if (target.efforts.length === 1) return target.efforts[0];

  const sourceStandard = sourceEfforts ? standardScale(sourceEfforts) : [];
  const sourceIndex = sourceStandard.findIndex(
    (effort) => normalizeEffortKey(effort) === sourceKey,
  );
  const sourceHasLowerOption =
    sourceStandard.length >= 2 ||
    (sourceStandard.length === 1 &&
      Boolean(sourceEfforts?.some(isDefaultOption)));
  if (
    sourceHasLowerOption &&
    sourceIndex >= 0 &&
    sourceIndex === sourceStandard.length - 1
  ) {
    return targetCeiling;
  }

  const exactStandard = targetStandard.find(
    (effort) => normalizeEffortKey(effort) === sourceKey,
  );
  if (exactStandard) return exactStandard;

  const srcRank = rankOf(sourceEffort);
  if (srcRank >= 0 && targetStandard.length > 0) {
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const candidate of targetStandard) {
      const candidateRank = rankOf(candidate);
      if (candidateRank < 0) continue;
      const distance = Math.abs(candidateRank - srcRank);
      if (
        distance < bestDistance ||
        (distance === bestDistance && candidateRank < bestRank)
      ) {
        best = candidate;
        bestDistance = distance;
        bestRank = candidateRank;
      }
    }
    if (best) return best;
  }

  if (
    sourceStandard.length >= 2 &&
    sourceIndex >= 0 &&
    targetStandard.length > 0
  ) {
    const ratio = sourceIndex / (sourceStandard.length - 1);
    const index = Math.round(ratio * (targetStandard.length - 1));
    return targetStandard[index];
  }

  return target.defaultEffort;
}
