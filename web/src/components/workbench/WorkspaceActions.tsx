import {
  Ellipsis,
  Maximize2,
  MessageCircle,
  Minimize2,
  PanelRight,
  Plus,
  Search,
} from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  toolbarTools,
  usePreferences,
  workspaceTools,
  type WorkspaceTool,
} from "@/features/settings/Preferences";
import { cn } from "@/lib/utils";
import { tabIcons } from "./WorkspaceTabs";
import type { WorkspaceTab } from "./useWorkspaces";

const availableTools = (canOpenDiff: boolean) =>
  workspaceTools.filter((kind) => canOpenDiff || kind !== "diff");
export function toolTab(kind: WorkspaceTool, sessionId?: string): WorkspaceTab {
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
  gitStatus,
  history,
  onSearch,
  ...newTabActions
}: {
  compact: boolean;
  selected?: WorkspaceTab;
  gitStatus?: ReactNode;
  history?: ReactNode;
  onSearch?: MouseEventHandler<HTMLButtonElement>;
} & NewTabActions) {
  const { t } = useTranslation();
  const { archived, onNewChat, onOpen } = newTabActions;
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
      {history}
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
          <ToolbarTools
            selected={selected}
            gitStatus={gitStatus}
            onOpen={onOpen}
          />
        </>
      )}
    </>
  );
}

function ToolbarTools({
  selected,
  gitStatus,
  onOpen,
}: {
  selected?: WorkspaceTab;
  gitStatus?: ReactNode;
  onOpen: (tab: WorkspaceTab) => void;
}) {
  const { t } = useTranslation();
  const {
    preferences: { hiddenWorkspaceTools },
    updatePreferences,
  } = usePreferences();
  const hidden = toolbarTools.filter((kind) =>
    hiddenWorkspaceTools.includes(kind),
  );
  const moreLabel = t("workspace.moreTools");
  return (
    <>
      {toolbarTools
        .filter((kind) => !hidden.includes(kind))
        .map((kind) => {
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
      {gitStatus}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={moreLabel}
            title={moreLabel}
            className={cn(
              hidden.some((kind) => kind === selected?.kind) &&
                "text-foreground bg-accent",
            )}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {hidden.length > 0 && (
            <>
              <DropdownMenuGroup>
                {hidden.map((kind) => {
                  const Icon = tabIcons[kind];
                  return (
                    <DropdownMenuItem
                      key={kind}
                      onSelect={() => onOpen(toolTab(kind))}
                    >
                      <Icon />
                      {t(`workspace.${kind}`)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("workspace.toolbarTools")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-36">
              {toolbarTools.map((kind) => {
                const Icon = tabIcons[kind];
                return (
                  <DropdownMenuCheckboxItem
                    key={kind}
                    checked={!hiddenWorkspaceTools.includes(kind)}
                    // Keep the menu open while arranging several tools.
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(shown) =>
                      updatePreferences({
                        hiddenWorkspaceTools: toolbarTools.filter((tool) =>
                          tool === kind
                            ? !shown
                            : hiddenWorkspaceTools.includes(tool),
                        ),
                      })
                    }
                  >
                    <Icon />
                    {t(`workspace.${kind}`)}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function WorkspacePanelControls({
  compact,
  visible,
  hasTabs,
  maximized,
  leading,
  onToggle,
  onMaximize,
  ...newTabActions
}: {
  compact?: boolean;
  visible: boolean;
  hasTabs: boolean;
  maximized: boolean;
  leading?: ReactNode;
  onToggle: () => void;
  onMaximize: () => void;
} & NewTabActions) {
  const { t } = useTranslation();
  const controls = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = controls.current;
    const layout = element?.parentElement;
    if (!element || !layout) return;
    const sync = () => {
      layout.style.setProperty(
        "--workspace-controls-width",
        `${Math.ceil(element.getBoundingClientRect().width)}px`,
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer.disconnect();
      layout.style.removeProperty("--workspace-controls-width");
    };
  }, []);
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
    <div className="workspace-panel-controls" ref={controls}>
      {leading}
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
