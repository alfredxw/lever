import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menubar } from "radix-ui";
import { currentWindow } from "mygo-runtime";
import { toast } from "sonner";
import { Appearance, Dialogs } from "@/api/desktop.gen";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/features/settings/Preferences";
import {
  ariaShortcut,
  binding,
  formatShortcut,
  type WorkspaceShortcut,
} from "@/features/settings/shortcuts";

type MenuName = "file" | "edit" | "view" | "help";

export function DesktopTitlebar({
  dark,
  sidebarOpen,
  onNewChat,
  onCloseTab,
  onSearch,
  onFind,
  onToggleSidebar,
  onOpenSettings,
}: {
  dark: boolean;
  sidebarOpen: boolean;
  onNewChat?: () => void;
  onCloseTab?: () => void;
  onSearch?: (trigger: HTMLElement | null) => void;
  onFind?: (trigger: HTMLElement | null) => void;
  onToggleSidebar?: () => void;
  onOpenSettings: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { preferences } = usePreferences();
  const editTrigger = useRef<HTMLButtonElement>(null);
  const focusTransfer = useRef<MenuName | null>(null);
  const captionUpdate = useRef(Promise.resolve());

  useEffect(() => {
    // Native calls are concurrent. Apply theme changes in order.
    captionUpdate.current = captionUpdate.current
      .then(() => Appearance.setWindowButtonsTheme(dark))
      .catch((error) =>
        console.error("Desktop caption theme sync failed", error),
      );
  }, [dark]);

  function workspaceItem(
    command: WorkspaceShortcut,
    action: (() => void) | undefined,
    {
      label = t(`settings.shortcut.${command}`),
      focusFrom,
    }: { label?: string; focusFrom?: MenuName } = {},
  ) {
    const shortcut = binding(preferences.shortcutOverrides, command);
    return (
      <Menubar.Item
        className="desktop-menu-item"
        disabled={!action}
        aria-keyshortcuts={action ? ariaShortcut(shortcut) : undefined}
        onSelect={() => {
          if (focusFrom) focusTransfer.current = focusFrom;
          action?.();
        }}
      >
        {label}
        {shortcut && (
          <span
            className="ml-auto whitespace-nowrap text-xs text-muted-foreground"
            aria-hidden="true"
          >
            {formatShortcut(shortcut)}
          </span>
        )}
      </Menubar.Item>
    );
  }

  function menu(name: MenuName, children: ReactNode) {
    return (
      <Menubar.Menu value={name}>
        <Menubar.Trigger asChild>
          <Button
            ref={name === "edit" ? editTrigger : undefined}
            variant="ghost"
            size="sm"
            className="text-foreground"
          >
            {t(`titlebar.${name}`)}
          </Button>
        </Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content
            className="floating-surface z-50 min-w-32 p-1 text-popover-foreground"
            sideOffset={4}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              if (focusTransfer.current !== name) return;
              focusTransfer.current = null;
              event.preventDefault();
            }}
          >
            {children}
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    );
  }

  const guide = i18n.language === "zh-CN" ? "README.zh.md" : "README.md";

  return (
    <header className="desktop-titlebar">
      <span>Lever</span>
      <Menubar.Root
        className="flex items-center gap-0.5"
        aria-label={t("titlebar.menu")}
      >
        {menu(
          "file",
          <>
            <Menubar.Group>
              {workspaceItem("newChat", onNewChat, { focusFrom: "file" })}
              {workspaceItem("closeTab", onCloseTab, { focusFrom: "file" })}
            </Menubar.Group>
            <Menubar.Separator className="-mx-1 my-1 h-px bg-border" />
            <Menubar.Group>
              {workspaceItem("openSettings", onOpenSettings)}
            </Menubar.Group>
          </>,
        )}
        {menu(
          "edit",
          <Menubar.Group>
            {workspaceItem(
              "search",
              onSearch && (() => onSearch(editTrigger.current)),
              { focusFrom: "edit" },
            )}
            {workspaceItem(
              "find",
              onFind && (() => onFind(editTrigger.current)),
              { focusFrom: "edit" },
            )}
          </Menubar.Group>,
        )}
        {menu(
          "view",
          <Menubar.Group>
            {workspaceItem("toggleSidebar", onToggleSidebar, {
              label: t(sidebarOpen ? "agents.hideList" : "agents.showList"),
            })}
            <Menubar.Item
              className="desktop-menu-item"
              onSelect={() => {
                void currentWindow
                  .toggleFullScreen()
                  .catch((error) => toast.error(String(error)));
              }}
            >
              {t("titlebar.fullscreen")}
            </Menubar.Item>
          </Menubar.Group>,
        )}
        {menu(
          "help",
          <Menubar.Group>
            <Menubar.Item className="desktop-menu-item" asChild>
              <a
                href={`https://github.com/alfredxw/lever/blob/main/${guide}`}
                target="_blank"
                rel="noreferrer"
              >
                {t("titlebar.guide")}
              </a>
            </Menubar.Item>
            <Menubar.Item
              className="desktop-menu-item"
              onSelect={() => {
                void Dialogs.showAbout().catch((error) =>
                  toast.error(String(error)),
                );
              }}
            >
              {t("titlebar.about")}
            </Menubar.Item>
          </Menubar.Group>,
        )}
      </Menubar.Root>
    </header>
  );
}
