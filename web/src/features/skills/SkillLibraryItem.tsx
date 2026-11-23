import type { ReactNode } from "react";
import { Download, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, ProviderInfo, Skill } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { directoryName, displayPath } from "@/lib/paths";
import { SkillAgentsPopover } from "./SkillAgentsPopover";
import { SkillOriginGlyph } from "./SkillOriginGlyph";
import { SkillActionButton } from "./SkillRemoval";
import type { SkillGroup } from "./skillsQuery";

function libraryPath(skill: Skill, homeDir: string) {
  const root = skill.origin?.scopePath?.replaceAll("\\", "/");
  const path = skill.path.replaceAll("\\", "/");
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (skill.managed) return `skills/${directoryName(path)}`;
  return displayPath(skill.path, homeDir);
}

export function SkillLibraryItem({
  skill,
  group,
  homeDir,
  agents,
  providers,
  list,
  dimmed,
  duplicate,
  control,
  onOpen,
  onAction,
  onUpdate,
}: {
  skill: Skill;
  group: SkillGroup;
  homeDir: string;
  agents: Agent[];
  providers: ProviderInfo[];
  list: boolean;
  dimmed: boolean;
  duplicate: boolean;
  control?: ReactNode;
  onOpen: () => void;
  onAction: (skill: Skill) => void;
  onUpdate: () => void;
}) {
  const { t } = useTranslation();
  const name = skill.title || skill.name;
  const source =
    group.kind === "subscribed" || group.kind === "scope"
      ? group.label
      : t(`skills.originName.${group.kind}`);
  const path = displayPath(skill.path, homeDir);
  const shortPath = libraryPath(skill, homeDir);
  return (
    <div
      className={list ? "skills-list-row" : "skill-card"}
      role="group"
      aria-label={skill.name}
      data-dimmed={dimmed || undefined}
    >
      <div className="skill-item-head">
        <SkillOriginGlyph kind={group.kind} compact={list} />
        <div className="skill-item-identity">
          <Button
            variant="ghost"
            className="skill-card-open"
            onClick={onOpen}
            title={`${name} · /${skill.name}`}
          >
            <span className="truncate">{name}</span>
          </Button>
          <code className="skill-item-command" title={`/${skill.name}`}>
            /{skill.name}
          </code>
        </div>
        <div className="skill-item-action gap-1">
          {control}
          <SkillActionButton skill={skill} compact onAction={onAction} />
        </div>
      </div>
      <p className="skill-item-description" title={skill.description}>
        {skill.description}
      </p>
      <div className="skill-item-tags">
        <span
          className="skills-pill skill-source-pill"
          title={group.path || source}
        >
          {source}
        </span>
        {!list && skill.fileCount != null && skill.fileCount > 0 && (
          <span className="skills-tag tabular-nums">
            {t("skills.fileCount", { count: skill.fileCount })}
          </span>
        )}
        {skill.updateAvailable && (
          <button
            type="button"
            className="skills-pill skill-update-pill"
            data-tone="running"
            onClick={onUpdate}
          >
            <Download />
            {t("skills.updateAvailableBadge")}
            {group.availableCommit && (
              <code className="ms-1">{group.availableCommit.slice(0, 7)}</code>
            )}
          </button>
        )}
        {skill.localModified && (
          <span className="skills-pill" data-tone="attention">
            {t("skills.localModified")}
          </span>
        )}
        {duplicate && (
          <span
            className="skills-pill"
            data-tone="attention"
            title={t("skills.overviewHint")}
          >
            <TriangleAlert />
            {t("skills.duplicateBadge")}
          </span>
        )}
      </div>
      <div className="skill-card-footer">
        <code
          className="skill-card-path"
          data-absolute={shortPath === skill.path || undefined}
          title={path}
        >
          <bdi dir="ltr">{shortPath}</bdi>
        </code>
        {skill.available && (
          <SkillAgentsPopover
            skill={skill}
            agents={agents}
            providers={providers}
            variant={list ? "list" : "card"}
          />
        )}
      </div>
    </div>
  );
}
