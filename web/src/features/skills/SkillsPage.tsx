import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  Plus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, ProviderInfo, Skill } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { OverviewNavigation } from "@/components/workbench/OverviewNavigation";
import {
  SecondarySidebar,
  useSecondarySidebarState,
} from "@/components/workbench/SecondarySidebar";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { Files } from "@/features/files/Files";
import { directoryName, displayPath } from "@/lib/paths";
import { SkillDialog } from "./SkillDialog";
import { SkillsOverview } from "./SkillsOverview";
import { skillEntryTarget, skillsQuery, type SkillGroup } from "./skillsQuery";
import "./skills.css";

function countNames(names: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export default function SkillsPage({
  agents,
  selectedAgentId,
  providers,
  homeDir,
  dark,
}: {
  agents: Agent[];
  selectedAgentId: string;
  providers: ProviderInfo[];
  homeDir: string;
  dark: boolean;
}) {
  const { t } = useTranslation();
  const library = useQuery(skillsQuery);
  const { compact, sidebar, setSidebar } = useSecondarySidebarState();
  const [selection, setSelection] = useState<{
    id: string;
    revision: number;
    edit: boolean;
  }>();
  const [openSource, setOpenSource] = useState<string>();
  const [dialog, setDialog] = useState<"create" | "directory">();
  const frame = useRef<HTMLElement>(null);
  const skills = library.data ?? [];
  const selected = skills.find((skill) => skill.id === selection?.id);
  const file = useMemo(
    () => selected && skillEntryTarget(selected),
    [selected?.id, selected?.path, selected?.managed],
  );
  const names = countNames(skills.map((skill) => skill.name));
  const managed: Skill[] = [];
  const user: Skill[] = [];
  const external: Skill[] = [];
  const scopes = new Map<string, Skill[]>();
  for (const skill of skills) {
    if (skill.managed) managed.push(skill);
    else if (skill.origin?.scopePath) {
      const path = skill.origin.scopePath;
      const entries = scopes.get(path);
      if (entries) entries.push(skill);
      else scopes.set(path, [skill]);
    } else if (skill.origin) user.push(skill);
    else external.push(skill);
  }
  const scopeNames = countNames(Array.from(scopes.keys(), directoryName));
  const groups: SkillGroup[] = [
    { key: "managed", label: t("skills.managed"), path: "", entries: managed },
    { key: "user", label: t("skills.userSources"), path: "", entries: user },
    ...Array.from(scopes, ([path, entries]) => {
      const name = directoryName(path);
      return {
        key: path,
        label:
          (scopeNames.get(name.toLowerCase()) ?? 0) > 1
            ? displayPath(path, homeDir)
            : name,
        path,
        entries,
      };
    }).sort((a, b) => a.label.localeCompare(b.label)),
    {
      key: "external",
      label: t("skills.external"),
      path: "",
      entries: external,
    },
  ].filter((group) => group.entries.length > 0);
  function revealContent() {
    if (compact) {
      setSidebar(false);
      requestAnimationFrame(() =>
        frame.current
          ?.querySelector<HTMLButtonElement>(".sidebar-toggle")
          ?.focus(),
      );
    }
  }
  function select(skill: Skill, edit = false) {
    setSelection((current) => ({
      id: skill.id,
      revision: (current?.revision ?? 0) + 1,
      edit,
    }));
    const group = groups.find(({ entries }) =>
      entries.some(({ id }) => id === skill.id),
    );
    setOpenSource(group?.key ?? (skill.managed ? "managed" : "external"));
    revealContent();
  }
  function showOverview() {
    setSelection(undefined);
    revealContent();
  }
  return (
    <section
      ref={frame}
      className="workspace-frame skills-page"
      data-sidebar={sidebar}
      aria-label={t("nav.skills")}
    >
      <SecondarySidebar
        id="skills-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <div className="sidebar-heading">
          <h1>{t("nav.skills")}</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("profile.addSkill")}
                title={t("profile.addSkill")}
              >
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => dialog && event.preventDefault()}
            >
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => setDialog("create")}>
                  <FileText />
                  {t("skills.create")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("directory")}>
                  <FolderOpen />
                  {t("skills.addDirectory")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <OverviewNavigation
          label={t("nav.skills")}
          groupLabel={t("skills.directories")}
          current={!selection}
          onOverview={showOverview}
        >
          {groups.length > 0 &&
            groups.map(({ key, label, path, entries }) => (
              <Collapsible
                key={key}
                open={openSource === key}
                onOpenChange={(open) => setOpenSource(open ? key : undefined)}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="sidebar-nav-item skills-group"
                    title={path ? displayPath(path, homeDir) : undefined}
                  >
                    <Folder data-icon="inline-start" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <ChevronRight className="skills-folder-chevron" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent
                  role="group"
                  aria-label={label}
                  className="sidebar-nav-children"
                >
                  {entries.map((skill) => {
                    const name = skill.name.toLowerCase();
                    const duplicate = (names.get(name) ?? 0) > 1;
                    const source = skill.origin?.directory;
                    const location =
                      duplicate &&
                      source &&
                      !entries.some(
                        (peer) =>
                          peer.id !== skill.id &&
                          peer.name.toLowerCase() === name &&
                          peer.origin?.directory === source,
                      )
                        ? source
                        : skill.path;
                    return (
                      <Button
                        key={skill.id}
                        variant="ghost"
                        className="sidebar-nav-item skills-row"
                        aria-current={
                          selected?.id === skill.id ? "page" : undefined
                        }
                        title={displayPath(skill.path, homeDir)}
                        onClick={() => select(skill)}
                      >
                        <FileText data-icon="inline-start" />
                        <span className="min-w-0 truncate">
                          {skill.name}
                          {duplicate && (
                            <small
                              className="block truncate text-muted-foreground"
                              dir="rtl"
                            >
                              {displayPath(location, homeDir)}
                            </small>
                          )}
                        </span>
                      </Button>
                    );
                  })}
                </CollapsibleContent>
              </Collapsible>
            ))}
        </OverviewNavigation>
      </SecondarySidebar>
      <div className="skills-content" inert={compact && sidebar}>
        {library.isPending ? (
          <Loading />
        ) : library.error && !library.data ? (
          <ErrorNotice
            error={library.error}
            retry={() => void library.refetch()}
          />
        ) : (
          <SkillsOverview
            groups={groups}
            agents={agents}
            selectedAgentId={selectedAgentId}
            providers={providers}
            homeDir={homeDir}
            onOpen={select}
            onCreate={() => setDialog("create")}
            visible={!selection}
          />
        )}
        {selection &&
          (selected?.available && file ? (
            <Files
              key={`${selected.id}:${selection.revision}`}
              source={file.source}
              scope={{ roots: [file.root], primaryRootId: file.root.id }}
              initialFile={file}
              initialPreview={!selection.edit}
              dark={dark}
              active={!compact || !sidebar}
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("common.overview")}
                    title={t("common.overview")}
                    onClick={showOverview}
                  >
                    <LayoutGrid />
                  </Button>
                  <SkillAgents
                    agents={agents.filter((agent) =>
                      selected.agentIds.includes(agent.id),
                    )}
                  />
                </>
              }
            />
          ) : (
            <div className="skills-empty">
              <ErrorNotice
                error={
                  selected
                    ? `${t("skills.unavailable")} · ${displayPath(selected.path, homeDir)}`
                    : t("skills.unavailable")
                }
                retry={() => void library.refetch()}
              />
              <Button variant="ghost" onClick={showOverview}>
                <LayoutGrid />
                {t("common.overview")}
              </Button>
            </div>
          ))}
      </div>
      {dialog && (
        <SkillDialog
          mode={dialog}
          homeDir={homeDir}
          onClose={() => setDialog(undefined)}
          onSaved={(skill) => {
            select(skill, dialog === "create");
            setDialog(undefined);
          }}
        />
      )}
    </section>
  );
}

function SkillAgents({ agents }: { agents: Agent[] }) {
  const { t } = useTranslation();
  if (!agents.length) return null;
  const label = t("skills.usedBy");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="skills-agent-trigger"
          aria-label={label}
          title={label}
        >
          <AgentAvatar agent={agents[0]} size="sm" />
          {agents.length > 1 && (
            <span className="tabular-nums">{agents.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2" aria-label={label}>
        <ul className="max-h-64 overflow-y-auto">
          {agents.map((agent) => (
            <li
              className="flex min-w-0 items-center gap-2 px-2 py-1.5"
              key={agent.id}
            >
              <AgentAvatar agent={agent} size="sm" />
              <span className="truncate" title={agent.name}>
                {agent.name}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
