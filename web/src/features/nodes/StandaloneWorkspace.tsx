import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pair } from "@/api/client";
import { Loading, ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { NodeWorkspace } from "./NodeWorkspace";
import { NodeAgentForm, canManage } from "./NodeAgentForm";
import { nodeApi, type NodeOverview } from "./nodes";

export function StandaloneWorkspace() {
  const params = new URLSearchParams(location.search);
  const id = params.get("node") ?? "";
  const [agent, choose] = useState(params.get("agent") ?? "");
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const auth = useQuery({
    queryKey: ["workspace-login", id],
    queryFn: async () => {
      await pair();
      return true;
    },
    retry: false,
    staleTime: Infinity,
  });
  const view = useQuery({
    queryKey: ["node", id, "overview"],
    queryFn: () => nodeApi<NodeOverview>(id, "/overview"),
    enabled: !!auth.data,
  });
  if (auth.error || view.error)
    return <ErrorNotice error={(auth.error ?? view.error)!} />;
  if (!view.data) return <Loading />;
  const { node, agents } = view.data;
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      {canManage(node) && (
        <div className="flex justify-end border-b px-3 py-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "取消" : "新建 Agent"}
          </Button>
        </div>
      )}
      {creating && canManage(node) ? (
        <NodeAgentForm
          node={node}
          done={(saved) => {
            choose(saved.id);
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ["node", id, "overview"] });
          }}
        />
      ) : agent || agents?.[0]?.id ? (
        <NodeWorkspace
          key={agent}
          node={node}
          agentId={agent || agents[0].id}
          initialChat={
            agent === params.get("agent")
              ? params.get("chat") || undefined
              : undefined
          }
          index={view.data}
          dark={matchMedia("(prefers-color-scheme: dark)").matches}
        />
      ) : (
        <p className="p-4 text-muted-foreground">此设备尚未开放 Agent。</p>
      )}
    </main>
  );
}
