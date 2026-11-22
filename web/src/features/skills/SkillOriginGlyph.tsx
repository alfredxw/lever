import { CodeXml, FolderOpen, Globe, Rss, Sparkles } from "lucide-react";
import type { SkillGroup } from "./skillsQuery";

const icons = {
  managed: Sparkles,
  subscribed: Rss,
  user: Globe,
  scope: CodeXml,
  external: FolderOpen,
};

export function SkillOriginGlyph({
  kind,
  compact,
}: {
  kind: SkillGroup["kind"];
  compact?: boolean;
}) {
  const Icon = icons[kind];
  return (
    <span
      className="skill-glyph"
      data-kind={kind}
      data-compact={compact || undefined}
      aria-hidden="true"
    >
      <Icon />
    </span>
  );
}
