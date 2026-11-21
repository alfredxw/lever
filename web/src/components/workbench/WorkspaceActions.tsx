import {
  Maximize2,
  MessageCircle,
  Minimize2,
  PanelRight,
  Plus,
  Search,
} from "lucide-react";
import type { MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { tabIcons } from "./WorkspaceTabs";
import type { WorkspaceTab } from "./useWorkspaces";

const tools = [
  "files",
  "diff",
  "terminal",
  "browser",
  "notes",
  "profile",
] as const;
const availableTools = (canOpenDiff: boolean) =>
  tools.filter((kind) => canOpenDiff || kind !== "diff");
export function toolTab(
  kind: (typeof tools)[number],
  sessionId?: string,
): WorkspaceTab {
  const id = sessionId ? `${kind}:${sessionId}` : kind;
  return {
    id:
      kind === "terminal" || kind === "browser"
        ? `${id}:${crypto.randomUUID()}`
        : id,
    kind,
    title: kind,
    sessionId,
  };
}
type NewTabActions = {
  archived: boolean;
  canOpenDiff: boolean;
  onNewChat: () => void;
  onOpen: (tab: WorkspaceTab) => void;
};

export function WorkspaceActions({
  compact,
  selected,
  onSearch,
  ...newTabActions
}: {
  compact: boolean;
  selected?: WorkspaceTab;
  onSearch?: MouseEventHandler<HTMLButtonElement>;
} & NewTabActions) {
  const { t } = useTranslation();
  const { archived, canOpenDiff, onNewChat, onOpen } = newTabActions;
  return (
    <>
      {onSearch && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("conversationSearch.searchAgent")}
          aria-haspopup="dialog"
          title={t("conversationSearch.searchAgent")}
          onClick={onSearch}
        >
          <Search aria-hidden="true" />
        </Button>
      )}
      {compact ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("workspace.openTab")}
              title={t("workspace.openTab")}
            >
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <NewTabMenuItems {...newTabActions} />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("workspace.newChat")}
          title={t("workspace.newChat")}
          onClick={onNewChat}
          disabled={archived}
        >
          <Plus />
        </Button>
      )}
      {!compact && (
        <>
          <span className="tab-action-divider" />
          {availableTools(canOpenDiff).map((kind) => {
            const Icon = tabIcons[kind];
            return (
              <Button
                key={kind}
                variant="ghost"
                size="icon-sm"
                aria-label={t(`workspace.${kind}`)}
                title={t(`workspace.${kind}`)}
                className={cn(
                  selected?.kind === kind && "text-foreground bg-accent",
                )}
                onClick={() => onOpen(toolTab(kind))}
              >
                <Icon />
              </Button>
            );
          })}
        </>
      )}
    </>
  );
}

export function WorkspacePanelControls({
  compact,
  visible,
  hasTabs,
  maximized,
  onToggle,
  onMaximize,
  ...newTabActions
}: {
  compact?: boolean;
  visible: boolean;
  hasTabs: boolean;
  maximized: boolean;
  onToggle: () => void;
  onMaximize: () => void;
} & NewTabActions) {
  const { t } = useTranslation();
  const sideLabel = t(
    visible ? "workspace.hideSidePane" : "workspace.showSidePane",
  );
  const maximizeLabel = t(
    maximized ? "workspace.restorePanel" : "workspace.maximizePanel",
  );
  const sideButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={sideLabel}
      title={sideLabel}
      aria-pressed={hasTabs ? visible : undefined}
      className={cn(visible && "text-foreground bg-accent")}
      onClick={hasTabs ? onToggle : undefined}
    >
      <PanelRight />
    </Button>
  );
  return (
    <div className="workspace-panel-controls">
      {visible && !compact && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          aria-pressed={maximized}
          onClick={onMaximize}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
      )}
      {hasTabs ? (
        sideButton
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{sideButton}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <NewTabMenuItems {...newTabActions} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function NewTabMenuItems({
  archived,
  canOpenDiff,
  onNewChat,
  onOpen,
}: NewTabActions) {
  const { t } = useTranslation();
  return (
    <DropdownMenuGroup>
      <DropdownMenuItem disabled={archived} onSelect={onNewChat}>
        <MessageCircle />
        {t("workspace.newChat")}
      </DropdownMenuItem>
      {availableTools(canOpenDiff).map((kind) => {
        const Icon = tabIcons[kind];
        return (
          <DropdownMenuItem key={kind} onSelect={() => onOpen(toolTab(kind))}>
            <Icon />
            {t(`workspace.${kind}`)}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  );
}
