import type { AutomationRunSummary } from "@/api/types.gen";
import { active } from "@/api/client";

function toneOf(status: string, silentPlan?: boolean) {
  if (status === "failed") return "err";
  if (status === "waiting_user") return "wait";
  if (status === "queued" || active(status)) return "run";
  if (status === "skipped" || (silentPlan && status === "completed"))
    return "silent";
  if (status === "completed") return "ok";
  return "silent";
}

export function AutomationSparkline({
  runs = [],
  variant = "bars",
  silentPlan = false,
  count = 7,
}: {
  runs?: AutomationRunSummary[];
  variant?: "bars" | "dots";
  silentPlan?: boolean;
  count?: number;
}) {
  const recent = runs.slice(0, count).reverse();
  const padded = [
    ...Array.from({ length: Math.max(0, count - recent.length) }, () => null),
    ...recent,
  ];
  return (
    <span
      className={
        variant === "dots" ? "automation-spark-dots" : "automation-spark-bars"
      }
      aria-hidden="true"
    >
      {padded.map((run, index) => (
        <i
          key={run?.runId ?? `empty-${index}`}
          data-tone={run ? toneOf(run.status, silentPlan) : "empty"}
        />
      ))}
    </span>
  );
}
