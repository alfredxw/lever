import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, ModelInfo } from "@/api/types.gen";
import type { NodeDescriptor } from "@/api/hub.gen";
import { ErrorNotice } from "@/components/common";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { nodeApi } from "./nodes";

type Choice = { id: string; name: string; available?: boolean };
export const canManage = (node: NodeDescriptor) =>
  node.online &&
  !node.draining &&
  node.accessLevel === "admin" &&
  node.features?.includes("agent_manage_v1");
function ChoiceField({
  label,
  value,
  items,
  change,
}: {
  label: string;
  value: string;
  items: Choice[];
  change: (id: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Select value={value} onValueChange={change}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {x.name || x.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function NodeTargetSelect({
  nodes,
  value,
  change,
  local = false,
}: {
  nodes: NodeDescriptor[];
  value: string;
  change: (id: string) => void;
  local?: boolean;
}) {
  const items = nodes.map((node) => ({ id: node.nodeId, name: node.name }));
  if (local) items.unshift({ id: "local", name: "本机" });
  return (
    <ChoiceField
      label="运行设备"
      value={value || "local"}
      items={items}
      change={(id) => change(id === "local" ? "" : id)}
    />
  );
}

export function NodeAgentForm({
  node,
  agent,
  done,
}: {
  node: NodeDescriptor;
  agent?: Agent;
  done: (a: Agent) => void;
}) {
  const id = node.nodeId;
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(
    agent?.profile.description ?? "",
  );
  const [instructions, setInstructions] = useState(
    agent?.profile.instructions ?? "",
  );
  const [provider, setProvider] = useState(agent?.profile.provider ?? "");
  const [model, setModel] = useState(agent?.profile.model ?? "");
  const [project, setProject] = useState(
    agent?.profile.projectId ? "project/" + agent.profile.projectId : "",
  );
  const [directory, setDirectory] = useState("");
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ["node", id, "providers"],
    queryFn: () => nodeApi<Choice[]>(id, "/providers"),
  });
  const projects = useQuery({
    queryKey: ["node", id, "projects"],
    queryFn: () => nodeApi<Choice[]>(id, "/projects"),
  });
  const roots = useQuery({
    queryKey: ["node", id, "browse-roots"],
    queryFn: () => nodeApi<Choice[]>(id, "/fs/browse"),
  });
  const [skillIDs, setSkillIDs] = useState<string[]>();
  const skills = useQuery({
    queryKey: ["node", id, "skills", agent?.id ?? ""],
    enabled: node.features.includes("agent_skills_v1"),
    queryFn: () =>
      nodeApi<(Choice & { selected?: boolean })[]>(
        id,
        "/skills" + (agent ? "?agent=" + encodeURIComponent(agent.id) : ""),
      ),
  });
  const selectedSkills =
    skillIDs ?? skills.data?.filter((s) => s.selected).map((s) => s.id) ?? [];
  const models = useQuery({
    queryKey: ["node", id, "models", provider],
    enabled: !!provider,
    queryFn: () =>
      nodeApi<ModelInfo[]>(
        id,
        `/providers/${encodeURIComponent(provider)}/models`,
      ),
  });
  const choices = [
    ...(projects.data ?? []).map((x) => ({ ...x, id: "project/" + x.id })),
    ...(roots.data ?? []).map((x) => ({ ...x, id: "root/" + x.id })),
  ];
  const save = useMutation({
    mutationFn: async (archive: boolean) => {
      const value = await nodeApi<Agent>(
        id,
        agent ? `/agents/${agent.id}` : "/agents",
        {
          name,
          description,
          instructions,
          provider,
          model,
          updatedAt: agent?.updatedAt,
          archived: archive,
          skillIds: skillIDs,
          ...(project.startsWith("project/")
            ? { projectId: project.slice(8) }
            : project.startsWith("root/")
              ? { rootId: project.slice(5), directory }
              : {}),
        },
        agent ? "PUT" : "POST",
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["node", id] }),
        qc.invalidateQueries({ queryKey: ["remote", "nodes"] }),
      ]);
      done(value);
    },
  });
  const error =
    save.error ||
    providers.error ||
    models.error ||
    projects.error ||
    roots.error ||
    skills.error;
  return (
    <form
      className="mx-auto flex w-full max-w-lg flex-col gap-3 overflow-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending) save.mutate(false);
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        名称
        <Input
          value={name}
          required
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <ChoiceField
        label="运行时"
        value={provider}
        items={(providers.data ?? []).filter(
          (p) => p.available || p.id === provider,
        )}
        change={(p) => {
          setProvider(p);
          setModel("");
        }}
      />
      {!!models.data?.length && (
        <ChoiceField
          label="模型"
          value={model}
          items={models.data}
          change={setModel}
        />
      )}
      <ChoiceField
        label="项目或允许目录"
        value={project}
        items={choices}
        change={setProject}
      />
      {project.startsWith("root/") && (
        <label className="flex flex-col gap-1 text-sm">
          子目录
          <Input
            placeholder="."
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
          />
        </label>
      )}
      {!agent && projects.isSuccess && roots.isSuccess && !choices.length && (
        <p className="text-sm text-muted-foreground">
          请先在目标设备创建项目，或在「远程与设备」添加允许目录。
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        简介
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        指令
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {!!skills.data?.length && (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm">技能</legend>
          {skills.data.map((skill) => (
            <label key={skill.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedSkills.includes(skill.id)}
                onCheckedChange={(checked) =>
                  setSkillIDs(
                    checked === true
                      ? [...selectedSkills, skill.id]
                      : selectedSkills.filter((id) => id !== skill.id),
                  )
                }
              />
              {skill.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && <ErrorNotice error={error} />}
      <div className="flex gap-2">
        <Button
          disabled={
            save.isPending ||
            !name.trim() ||
            !provider ||
            (!agent && !project) ||
            !canManage(node)
          }
        >
          {agent ? "保存" : "创建 Agent"}
        </Button>
        {agent && (
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending || !canManage(node)}
            onClick={() => {
              if (confirm("归档此 Agent？")) save.mutate(true);
            }}
          >
            归档
          </Button>
        )}
      </div>
    </form>
  );
}
