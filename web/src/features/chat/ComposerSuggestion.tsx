import {
  AtSign,
  ChevronRight,
  Columns2,
  CornerDownLeft,
  GitBranch,
  MessageCircle,
  Paperclip,
  ShieldCheck,
  Slash,
  SlidersHorizontal,
  Sparkles,
  Target,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ComposerOption } from "./composerActions";
import { ReferenceIcon } from "./References";

const icons = {
  attach: Paperclip,
  runApprovals: ShieldCheck,
  mention: AtSign,
  command: Slash,
  goal: Target,
  compare: Columns2,
  chat: MessageCircle,
  topic: GitBranch,
  model: SlidersHorizontal,
};

export function ComposerSuggestion({
  option,
  home,
  id,
  selected,
  onHighlight,
  onChoose,
}: {
  option: ComposerOption;
  home: boolean;
  id: string;
  selected: boolean;
  onHighlight: () => void;
  onChoose: () => void;
}) {
  const { name, description, action, command, native, reference } = option;
  const goal = native && (name === "/goal" || name.startsWith("/goal "));
  const icon = command ?? action;
  const Icon = icon
    ? icons[icon]
    : goal
      ? Target
      : reference?.kind === "skill"
        ? Sparkles
        : Terminal;
  const featured = home && (command || goal);
  const shortcut = featured
    ? name
    : action === "command" || action === "mention"
      ? description
      : undefined;
  const detail = shortcut ? undefined : description;
  return (
    <Button
      type="button"
      variant="ghost"
      tabIndex={-1}
      role="option"
      id={id}
      aria-selected={selected}
      aria-label={reference?.kind === "file" ? reference.name : undefined}
      className="composer-suggestion"
      title={reference?.path || [name, description].filter(Boolean).join(" · ")}
      onPointerMove={onHighlight}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
    >
      {reference && reference.kind !== "skill" ? (
        <ReferenceIcon kind={reference.kind} size={16} />
      ) : (
        <Icon size={16} />
      )}
      <span className="suggestion-copy">
        <span className="suggestion-name">{featured ? description : name}</span>
        {detail && <span className="suggestion-description">{detail}</span>}
        {shortcut && <kbd className="suggestion-shortcut">{shortcut}</kbd>}
      </span>
      {action === "command" || action === "mention" || action === "goal" ? (
        <ChevronRight className="size-3.5" aria-hidden="true" />
      ) : (
        <CornerDownLeft className="suggestion-enter" aria-hidden="true" />
      )}
    </Button>
  );
}
