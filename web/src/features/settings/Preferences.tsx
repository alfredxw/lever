import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  availableShortcuts,
  isMac,
  reservedShortcut,
  type ShortcutOverrides,
} from "./shortcuts";

export const chatFontSizes = [13, 14, 16, 18] as const;
export const chatWidths = ["comfortable", "wide", "full"] as const;
export const sendShortcuts = ["enter", "mod-enter"] as const;
export const followUpBehaviors = ["queue", "steer"] as const;

type Preferences = {
  chatFontSize: (typeof chatFontSizes)[number];
  chatWidth: (typeof chatWidths)[number];
  sendShortcut: (typeof sendShortcuts)[number];
  followUpBehavior: (typeof followUpBehaviors)[number];
  openNewTopicOnCreate: boolean;
  desktopNotifications: boolean;
  expandAgentActivity: boolean;
  secondarySidebarWidth: number | null;
  maxWorkspaceTabs: number | null;
  shortcutOverrides: ShortcutOverrides;
};

const defaults: Preferences = {
  chatFontSize: 14,
  chatWidth: "comfortable",
  sendShortcut: "enter",
  followUpBehavior: "steer",
  openNewTopicOnCreate: true,
  desktopNotifications: false,
  expandAgentActivity: true,
  secondarySidebarWidth: null,
  maxWorkspaceTabs: null,
  shortcutOverrides: {},
};
const storageKey = "lever:preferences";

export function isWorkspaceTabLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const shortcutOverrides: ShortcutOverrides = {};
    for (const command of availableShortcuts) {
      const value = saved?.shortcutOverrides?.[command];
      if (
        typeof value === "string" &&
        value &&
        !reservedShortcut(value, command)
      )
        shortcutOverrides[command] = value;
    }
    return {
      chatFontSize: chatFontSizes.includes(saved?.chatFontSize)
        ? saved.chatFontSize
        : defaults.chatFontSize,
      chatWidth: chatWidths.includes(saved?.chatWidth)
        ? saved.chatWidth
        : defaults.chatWidth,
      sendShortcut: sendShortcuts.includes(saved?.sendShortcut)
        ? saved.sendShortcut
        : defaults.sendShortcut,
      followUpBehavior: followUpBehaviors.includes(saved?.followUpBehavior)
        ? saved.followUpBehavior
        : defaults.followUpBehavior,
      openNewTopicOnCreate:
        typeof saved?.openNewTopicOnCreate === "boolean"
          ? saved.openNewTopicOnCreate
          : defaults.openNewTopicOnCreate,
      desktopNotifications: saved?.desktopNotifications === true,
      expandAgentActivity:
        saved?.expandAgentActivity ?? defaults.expandAgentActivity,
      secondarySidebarWidth:
        Number.isFinite(saved?.secondarySidebarWidth) &&
        saved.secondarySidebarWidth > 0
          ? saved.secondarySidebarWidth
          : defaults.secondarySidebarWidth,
      maxWorkspaceTabs: isWorkspaceTabLimit(saved?.maxWorkspaceTabs)
        ? saved.maxWorkspaceTabs
        : defaults.maxWorkspaceTabs,
      shortcutOverrides,
    };
  } catch {
    return defaults;
  }
}

const PreferencesContext = createContext<{
  preferences: Preferences;
  updatePreferences: (patch: Partial<Preferences>) => void;
} | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--chat-font-size",
      `${preferences.chatFontSize}px`,
    );
    document.documentElement.style.setProperty(
      "--chat-content-width",
      { comfortable: "850px", wide: "1100px", full: "none" }[
        preferences.chatWidth
      ],
    );
  }, [preferences.chatFontSize, preferences.chatWidth]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === storageKey || event.key === null)
      )
        setPreferences(readPreferences());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function updatePreferences(patch: Partial<Preferences>) {
    const next = { ...preferences, ...patch };
    // Persist before updating the UI so a failed write cannot appear saved.
    localStorage.setItem(storageKey, JSON.stringify(next));
    setPreferences(next);
  }

  return (
    <PreferencesContext value={{ preferences, updatePreferences }}>
      {children}
    </PreferencesContext>
  );
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("PreferencesProvider is missing");
  return context;
}

export function useComposerShortcuts() {
  const { preferences } = usePreferences();
  const modifier = isMac ? "⌘" : "Ctrl";
  const modified = preferences.sendShortcut === "mod-enter";
  return {
    modified,
    send: modified ? `${modifier} + Enter` : "Enter",
    alternate: `${modifier} + ${modified ? "Shift + " : ""}Enter`,
    newline: modified ? "Enter / Shift + Enter" : "Shift + Enter",
    followUp: {
      primary: preferences.followUpBehavior,
      alternate: preferences.followUpBehavior === "queue" ? "steer" : "queue",
    },
  } as const;
}
