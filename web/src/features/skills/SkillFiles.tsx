import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  CodeXml,
  Download,
  Eye,
  LayoutGrid,
  Save,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, ProviderInfo, Skill } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Files, type FileDocumentControls } from "@/features/files/Files";
import { SkillAgentsPopover } from "./SkillAgentsPopover";
import { SkillOriginGlyph } from "./SkillOriginGlyph";
import { SkillActionButton } from "./SkillRemoval";
import { skillEntryTarget, type SkillGroup } from "./skillsQuery";

export function SkillFiles({
  skill,
  kind,
  agents,
  providers,
  initialPreview,
  dark,
  active,
  onOverview,
  onConflict,
  onSubscriptions,
  onAction,
}: {
  skill: Skill;
  kind: SkillGroup["kind"];
  agents: Agent[];
  providers: ProviderInfo[];
  initialPreview: boolean;
  dark: boolean;
  active: boolean;
  onOverview: () => void;
  onConflict: () => void;
  onSubscriptions: () => void;
  onAction: (skill: Skill) => void;
}) {
  const { t } = useTranslation();
  const file = useMemo(
    () => skillEntryTarget(skill),
    [skill.id, skill.path, skill.managed, skill.subscriptionId],
  );
  function header(treeToggle: ReactNode, document?: FileDocumentControls) {
    const path = document?.path ?? "";
    const split = path.lastIndexOf("/") + 1;
    return (
      <div className="skill-file-heading">
        <header className="file-bar skill-file-bar">
          <div className="skill-file-location">
            <Button
              variant="ghost"
              size="xs"
              onClick={onOverview}
              aria-label={t("common.overview")}
              title={t("common.overview")}
            >
              <LayoutGrid />
              <span>{t("common.overview")}</span>
            </Button>
            <span className="skill-file-divider" aria-hidden="true" />
            {treeToggle}
            <nav
              className="skill-file-path"
              aria-label={t("files.path")}
              title={path ? `${skill.name} / ${path}` : skill.name}
            >
              <SkillOriginGlyph kind={kind} compact />
              <strong>{skill.name}</strong>
              {path && (
                <>
                  <span aria-hidden="true">/</span>
                  <span className="font-mono" aria-current="page">
                    <span className="skill-file-parent">
                      {path.slice(0, split)}
                    </span>
                    {path.slice(split)}
                  </span>
                </>
              )}
            </nav>
          </div>
          <div className="skill-file-actions">
            {document?.status}
            <ToggleGroup
              type="single"
              size="sm"
              className="catalog-segments"
              aria-label={t("files.viewMode")}
              value={document ? (document.preview ? "preview" : "source") : ""}
              onValueChange={(mode) => {
                if (document)
                  document.setPreview(
                    mode ? mode === "preview" : document.preview,
                  );
              }}
            >
              <ToggleGroupItem value="preview" disabled={!document}>
                <Eye />
                {t("files.preview")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="source"
                disabled={!document?.sourceAvailable}
              >
                <CodeXml />
                {t(document?.readOnly ? "files.sourceMode" : "files.editMode")}
              </ToggleGroupItem>
            </ToggleGroup>
            {document?.sourceAvailable &&
              !document.preview &&
              !document.readOnly && (
                <Button
                  size="xs"
                  variant={document.canSave ? "default" : "outline"}
                  disabled={!document.canSave}
                  onClick={document.save}
                  aria-label={t("files.save")}
                  title={t("files.saveShortcut")}
                >
                  <Save />
                  <span>{t("common.save")}</span>
                </Button>
              )}
            <SkillAgentsPopover
              skill={skill}
              agents={agents}
              providers={providers}
            />
            <SkillActionButton skill={skill} onAction={onAction} />
          </div>
        </header>
        {skill.subscriptionId &&
          (skill.localModified || skill.updateAvailable) && (
            <div
              className="skills-files-banner"
              data-tone={skill.localModified ? "warn" : "update"}
            >
              <div className="flex min-w-0 items-center gap-2 text-xs">
                {skill.localModified ? (
                  <AlertTriangle className="size-3.5 shrink-0" />
                ) : (
                  <Download className="size-3.5 shrink-0" />
                )}
                {t(
                  skill.localModified
                    ? "skills.localModifiedBanner"
                    : "skills.updateAvailableBanner",
                )}
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={skill.localModified ? onConflict : onSubscriptions}
              >
                {t(
                  skill.localModified
                    ? "skills.resolveConflict"
                    : "skills.reviewAndSync",
                )}
              </Button>
            </div>
          )}
      </div>
    );
  }
  return (
    <div className="skills-files-shell">
      <Files
        source={file.source}
        scope={{ roots: [file.root], primaryRootId: file.root.id }}
        initialFile={file}
        initialPreview={initialPreview}
        dark={dark}
        active={active}
        detail={{ rootLabel: skill.name, header }}
      />
    </div>
  );
}
