import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { DiffResult, Run } from "@/api/types.gen";

export function AutomationDiffExcerpt({
  run,
  rootId,
  path,
}: {
  run: Run;
  rootId: string;
  path: string;
}) {
  const patch = useQuery({
    queryKey: ["automation-diff-excerpt", run.id, rootId, path],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        mode: "turn",
        run: run.id,
        sessionId: run.sessionId,
        root: rootId,
        path,
      });
      const result = await api<DiffResult>(
        `/agents/${run.agentId}/diff?${params}`,
        undefined,
        "GET",
        signal,
      );
      const lines = result.patch.split("\n");
      const hunk = lines.findIndex((line) => line.startsWith("@@"));
      return hunk >= 0 ? lines.slice(hunk, hunk + 9) : [];
    },
    staleTime: Infinity,
    retry: false,
  });
  if (!patch.data?.length) return null;
  return (
    <div className="automation-diff-excerpt">
      <pre>
        {patch.data.map((line, index) => (
          <span
            key={index}
            data-change={
              line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : undefined
            }
          >
            {line || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}
