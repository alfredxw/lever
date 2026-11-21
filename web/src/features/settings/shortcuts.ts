import { useEffect, useEffectEvent } from "react";
import { isMyGo, runtime } from "mygo-runtime";

export const isDesktop = isMyGo();
export const isMac = isDesktop
  ? runtime().platform === "darwin"
  : navigator.platform.includes("Mac");
const mod = isMac ? "meta" : "ctrl";
const shiftedMod = isMac ? "shift+meta" : "ctrl+shift";
const modifierOrder = ["ctrl", "alt", "shift", "meta"] as const;

const workspaceShortcuts = {
  closeTab: isMac ? "meta+w" : "ctrl+f4",
  reopenTab: `${shiftedMod}+t`,
  previousTab: isMac ? `${shiftedMod}+[` : "ctrl+pageup",
  nextTab: isMac ? `${shiftedMod}+]` : "ctrl+pagedown",
  newChat: `${mod}+n`,
  search: `${mod}+k`,
  quickSearch: "meta+p",
  find: `${mod}+f`,
  toggleSidebar: `${mod}+b`,
  openSettings: `${mod}+,`,
} as const;

export type WorkspaceShortcut = keyof typeof workspaceShortcuts;
export type ShortcutOverrides = Partial<Record<WorkspaceShortcut, string>>;

export const tabShortcuts = [
  "closeTab",
  "reopenTab",
  "previousTab",
  "nextTab",
] as const;
const desktopOnly = new Set<WorkspaceShortcut>([...tabShortcuts, "newChat"]);
export const availableShortcuts = (
  Object.keys(workspaceShortcuts) as WorkspaceShortcut[]
).filter((command) =>
  command === "quickSearch"
    ? isDesktop && isMac
    : isDesktop || !desktopOnly.has(command),
);

export const fileSaveShortcut = `${mod}+s`;
export const fileFindShortcut = `${mod}+f`;
export const closeWindowShortcut = isMac ? `${shiftedMod}+w` : "alt+f4";
export const quitShortcut = "meta+q";

export function defaultShortcut(command: WorkspaceShortcut) {
  return workspaceShortcuts[command];
}

export function binding(
  overrides: ShortcutOverrides,
  command: WorkspaceShortcut,
) {
  const shortcut = defaultShortcut(command);
  // Existing custom assignments take precedence over newly introduced defaults.
  return (
    overrides[command] ??
    (availableShortcuts.some((other) => overrides[other] === shortcut)
      ? undefined
      : shortcut)
  );
}

const modifierLabels: Record<string, string> = isMac
  ? { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" }
  : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };
const keyLabels: Record<string, string> = {
  pageup: "Page Up",
  pagedown: "Page Down",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
};

export function formatShortcut(shortcut: string) {
  return shortcut
    .split("+")
    .map((key) => modifierLabels[key] ?? keyLabels[key] ?? key.toUpperCase())
    .join(isMac ? "" : " + ");
}

export function ariaShortcut(shortcut: string | undefined) {
  return shortcut
    ?.replace(/\bctrl\b/g, "Control")
    .replace(/\balt\b/g, "Alt")
    .replace(/\bshift\b/g, "Shift")
    .replace(/\bmeta\b/g, "Meta");
}

export function pressedShortcut(event: KeyboardEvent) {
  if (
    event.isComposing ||
    event.repeat ||
    event.getModifierState("AltGraph") ||
    !(event.metaKey || event.ctrlKey || event.altKey)
  )
    return;
  const modifiers = modifierOrder.filter((modifier) => event[`${modifier}Key`]);
  let key = event.key.toLowerCase();
  // Shift changes the produced character on layouts with braces above brackets.
  if (event.shiftKey && key === "{") key = "[";
  if (event.shiftKey && key === "}") key = "]";
  if (event.shiftKey && key === "+") key = "=";
  if (isMac && event.altKey && !/^[a-z0-9]$/.test(key)) {
    const letter = /^(?:Key|Digit)([A-Z0-9])$/.exec(event.code);
    if (letter) key = letter[1].toLowerCase();
  }
  if (
    !/^[a-z0-9]$|^f(?:[1-9]|1[0-2])$/.test(key) &&
    !Object.hasOwn(keyLabels, key) &&
    !["[", "]", ",", ".", ";", "/", "'", "\\", "`", "=", "-"].includes(key)
  )
    return;
  return [...modifiers, key].join("+");
}

export function tabNumber(shortcut: string) {
  if (!shortcut.startsWith(`${mod}+`)) return;
  const key = shortcut.slice(mod.length + 1);
  if (/^[1-9]$/.test(key)) return Number(key);
}

export const tabNumberRange = `${formatShortcut(`${mod}+1`)}–${formatShortcut(`${mod}+9`)}`;

const reservedKeys = new Set([
  fileSaveShortcut,
  closeWindowShortcut,
  ...["a", "c", "v", "x", "z", "y", "r", "0", "-", "="].map(
    (key) => `${mod}+${key}`,
  ),
  `${shiftedMod}+z`,
  isMac ? "ctrl+meta+f" : "ctrl+shift+r",
  ...(isMac
    ? [
        quitShortcut,
        "meta+h",
        "alt+meta+h",
        "meta+m",
        "alt+meta+i",
        "shift+meta+r",
      ]
    : []),
  ...(isDesktop
    ? []
    : ["w", "n", "t", "l", "p", "o"].map((key) => `${mod}+${key}`)),
  ...(isDesktop
    ? []
    : [
        `${shiftedMod}+t`,
        workspaceShortcuts.previousTab,
        workspaceShortcuts.nextTab,
      ]),
]);

export function reservedShortcut(shortcut: string, command: WorkspaceShortcut) {
  return (
    !!tabNumber(shortcut) ||
    reservedKeys.has(shortcut) ||
    (shortcut === fileFindShortcut && command !== "find")
  );
}

export function useShortcutListener(
  run: (shortcut: string, event: KeyboardEvent) => boolean | void,
  enabled = true,
) {
  const dispatch = useEffectEvent(run);
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      const shortcut = pressedShortcut(event);
      if (
        !shortcut ||
        event.defaultPrevented ||
        document.querySelector(
          ':is([role="dialog"], [role="alertdialog"])[data-state="open"]',
        ) ||
        (event.target instanceof Element &&
          event.target.closest('[role="menu"], [role="listbox"]'))
      )
        return;
      if (dispatch(shortcut, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
