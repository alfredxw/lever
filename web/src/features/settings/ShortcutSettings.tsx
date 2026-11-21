import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { usePreferences } from "./Preferences";
import { SettingsGroup, SettingsRow } from "./SettingsControls";
import {
  availableShortcuts,
  binding,
  closeWindowShortcut,
  defaultShortcut,
  fileFindShortcut,
  fileSaveShortcut,
  formatShortcut,
  isDesktop,
  isMac,
  pressedShortcut,
  quitShortcut,
  reservedShortcut,
  tabNumberRange,
  tabShortcuts,
  type ShortcutOverrides,
  type WorkspaceShortcut,
} from "./shortcuts";

type ShortcutRow = {
  label: string;
  keys: string;
  command?: WorkspaceShortcut;
};

export function shortcutGroups(overrides: ShortcutOverrides) {
  function row(command: WorkspaceShortcut): ShortcutRow {
    const shortcut = binding(overrides, command);
    return {
      label: `settings.shortcut.${command}`,
      keys: shortcut ? formatShortcut(shortcut) : "",
      command,
    };
  }
  return [
    ...(isDesktop
      ? [
          {
            title: "settings.tabShortcuts",
            rows: [
              ...tabShortcuts.map(row),
              { label: "settings.jumpTab", keys: tabNumberRange },
            ],
          },
        ]
      : []),
    {
      title: "settings.workspaceShortcuts",
      rows: availableShortcuts
        .filter(
          (command) =>
            !tabShortcuts.some((tabCommand) => tabCommand === command),
        )
        .map(row),
    },
    {
      title: "settings.files",
      rows: [
        { label: "settings.findFile", keys: formatShortcut(fileFindShortcut) },
        { label: "settings.saveFile", keys: formatShortcut(fileSaveShortcut) },
      ],
    },
    ...(isDesktop
      ? [
          {
            title: "settings.windowShortcuts",
            rows: [
              {
                label: "settings.closeWindow",
                keys: formatShortcut(closeWindowShortcut),
              },
              ...(isMac
                ? [
                    {
                      label: "settings.quitApp",
                      keys: formatShortcut(quitShortcut),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
  ] satisfies { title: string; rows: ShortcutRow[] }[];
}

export function ShortcutSettings({
  groups,
}: {
  groups: ReturnType<typeof shortcutGroups>;
}) {
  const { t } = useTranslation();
  return groups.map(({ title, rows }) => (
    <SettingsGroup key={title} title={t(title)}>
      {rows.map(({ label, keys, command }: ShortcutRow) => (
        <SettingsRow key={label} title={t(label)}>
          {command ? (
            <EditShortcut
              command={command}
              label={t(label)}
              keys={keys || t("settings.shortcutUnassigned")}
            />
          ) : (
            <kbd>{keys}</kbd>
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  ));
}

function EditShortcut({
  command,
  label,
  keys,
}: {
  command: WorkspaceShortcut;
  label: string;
  keys: string;
}) {
  const { t } = useTranslation();
  const {
    preferences: { shortcutOverrides },
    updatePreferences,
  } = usePreferences();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  function save(shortcut: string) {
    const conflict = availableShortcuts.find(
      (other) =>
        other !== command && binding(shortcutOverrides, other) === shortcut,
    );
    if (conflict) {
      setError(
        t("settings.shortcutConflict", {
          command: t(`settings.shortcut.${conflict}`),
        }),
      );
      return;
    }
    if (reservedShortcut(shortcut, command)) {
      setError(t("settings.shortcutReserved"));
      return;
    }
    const next = { ...shortcutOverrides };
    if (shortcut === defaultShortcut(command)) delete next[command];
    else next[command] = shortcut;
    try {
      updatePreferences({ shortcutOverrides: next });
      setOpen(false);
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError("");
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("settings.editShortcut", { label, keys })}
        >
          <span>{keys}</span>
          <Pencil aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent
        onKeyDownCapture={(event) => {
          const shortcut = pressedShortcut(event.nativeEvent);
          if (!shortcut) return;
          event.preventDefault();
          event.stopPropagation();
          save(shortcut);
        }}
      >
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{t("settings.pressShortcut")}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {shortcutOverrides[command] && (
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => save(defaultShortcut(command))}
            >
              {t("settings.resetShortcut")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
