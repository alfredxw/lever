import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, SmilePlus } from "lucide-react";
import type { Agent, Avatar } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "./AgentAvatar";
import { avatarPalette, defaultAvatar } from "./avatarPalette";
import { avatarIconNames, popularAvatarIcons } from "./avatarIcons";

const emojis = [
  defaultAvatar.value,
  "🦊",
  "🐱",
  "🐶",
  "🐼",
  "🐻",
  "🐨",
  "🐯",
  "🦁",
  "🐸",
  "🐵",
  "🐰",
  "🐹",
  "🐭",
  "🐺",
  "🦝",
  "🦄",
  "🐴",
  "🦓",
  "🦒",
  "🐘",
  "🦥",
  "🦔",
  "🐧",
  "🦉",
  "🦅",
  "🦆",
  "🐙",
  "🐳",
  "🐬",
  "🦋",
  "🐝",
  "🌱",
  "🌿",
  "🍀",
  "🌳",
  "🌵",
  "🎋",
  "🍁",
  "🍂",
  "🍄",
  "🌻",
  "🌸",
  "🌺",
  "🌷",
  "🌹",
  "🪷",
  "🪴",
  "🚀",
  "🛸",
  "🪐",
  "🌍",
  "🌐",
  "🌙",
  "⭐",
  "🌟",
  "✨",
  "☀️",
  "☁️",
  "🌈",
  "⚡",
  "🔥",
  "❄️",
  "🌊",
  "🍎",
  "🍊",
  "🍋",
  "🍉",
  "🍇",
  "🍓",
  "🫐",
  "🍒",
  "🥑",
  "🥕",
  "🌽",
  "🍕",
  "🍣",
  "🍩",
  "☕",
  "🍵",
  "🧠",
  "💻",
  "🖥️",
  "⌨️",
  "🖱️",
  "🛠️",
  "⚙️",
  "🔧",
  "🔬",
  "🧪",
  "🧬",
  "🔭",
  "💡",
  "🔋",
  "🛰️",
  "📡",
  "🎨",
  "🎭",
  "🎬",
  "🎤",
  "🎧",
  "🎵",
  "🎸",
  "🎹",
  "🎮",
  "🎲",
  "🧩",
  "♟️",
  "⚽",
  "🏀",
  "🎯",
  "🏆",
  "📦",
  "📚",
  "📖",
  "✏️",
  "📝",
  "📊",
  "📈",
  "🗂️",
  "🔒",
  "🔑",
  "🧭",
  "🗺️",
  "💎",
  "🪄",
  "🛡️",
  "🔔",
];
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const monogramPattern = /^[\p{L}\p{N}]{0,2}$/u;
function firstGrapheme(text: string) {
  return segmenter.segment(text.trim()).containing(0)?.segment ?? "";
}
function isEmoji(grapheme: string) {
  return (
    /^\p{Extended_Pictographic}/u.test(grapheme) ||
    /^\p{Regional_Indicator}{2}$/u.test(grapheme) ||
    /^[#*0-9]\uFE0F?\u20E3$/u.test(grapheme)
  );
}

export default function AvatarPicker({
  agent,
  onChange,
}: {
  agent: Pick<Agent, "id" | "name" | "avatar">;
  onChange: (avatar: Avatar) => void;
}) {
  const { t } = useTranslation();
  const { id, name, avatar: value } = agent;
  const [mode, setMode] = useState(value?.kind ?? defaultAvatar.kind);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(() =>
    value?.kind === "emoji" && !emojis.includes(value.value)
      ? firstGrapheme(value.value)
      : "",
  );
  const [letters, setLetters] = useState(
    value?.kind === "monogram" ? value.value : "",
  );
  const normalized = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = normalized
    ? avatarIconNames
        .filter((name) => name.toLowerCase().includes(normalized))
        .slice(0, 60)
    : popularAvatarIcons;
  const iconColor = value?.color || defaultAvatar.color;
  const choose = (kind: string, text: string) =>
    onChange({ kind, value: text, color: value?.color });
  const editCustomEmoji = (text: string) => {
    const grapheme = firstGrapheme(text);
    setCustom(grapheme);
    if (isEmoji(grapheme)) choose("emoji", grapheme);
  };
  return (
    <div className="space-y-3">
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList className="w-full" aria-label={t("agents.avatarType")}>
          <TabsTrigger value="emoji">
            {t("agents.avatarType.emoji")}
          </TabsTrigger>
          <TabsTrigger value="lucide">
            {t("agents.avatarType.lucide")}
          </TabsTrigger>
          <TabsTrigger value="monogram">
            {t("agents.avatarType.monogram")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="lucide" className="space-y-3">
          <Input
            type="search"
            aria-label={t("agents.searchIcons")}
            placeholder={t("agents.searchIcons")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="avatar-option-grid">
            {names.map((icon) => {
              const avatar = {
                kind: "lucide",
                value: icon,
                color: iconColor,
              };
              return (
                <Button
                  key={icon}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={icon}
                  title={icon}
                  aria-pressed={
                    value?.kind === "lucide" && value.value === icon
                  }
                  className="aria-pressed:bg-accent"
                  onClick={() => onChange(avatar)}
                >
                  <AgentAvatar agent={{ id, name, avatar }} size="sm" />
                </Button>
              );
            })}
          </div>
          {!names.length && (
            <p className="text-sm text-muted-foreground">
              {t("agents.noIcons")}
            </p>
          )}
        </TabsContent>
        <TabsContent value="emoji" className="space-y-3">
          <div className="avatar-option-grid">
            {emojis.map((emoji) => (
              <Button
                key={emoji}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("agents.chooseEmoji", { emoji })}
                aria-pressed={value?.kind === "emoji" && value.value === emoji}
                className="text-xl aria-pressed:bg-accent"
                onClick={() => {
                  setCustom("");
                  choose("emoji", emoji);
                }}
              >
                {emoji}
              </Button>
            ))}
          </div>
          <label className="flex h-9 cursor-text items-center gap-2 rounded-lg border border-transparent bg-muted px-2 transition-colors focus-within:bg-control-selected has-aria-invalid:border-destructive">
            <SmilePlus
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Input
              className="avatar-emoji-input h-full border-0 bg-transparent p-0 text-lg placeholder:font-sans placeholder:text-[length:var(--text-control)] focus-visible:bg-transparent md:text-lg"
              aria-label={t("agents.customEmoji")}
              placeholder={t("agents.customEmojiPlaceholder")}
              spellCheck={false}
              value={custom}
              aria-invalid={!!custom && !isEmoji(custom)}
              onFocus={(event) => event.currentTarget.select()}
              onMouseDown={(event) => {
                const input = event.currentTarget;
                if (event.button !== 0 || !input.value) return;
                // WebKit can place the caret after focus on the first click.
                event.preventDefault();
                input.focus();
                input.select();
              }}
              onClick={(event) => event.currentTarget.select()}
              onChange={(event) => {
                const text = event.currentTarget.value;
                if ((event.nativeEvent as InputEvent).isComposing) {
                  setCustom(text);
                } else {
                  editCustomEmoji(text);
                }
              }}
              onCompositionEnd={(event) =>
                editCustomEmoji(event.currentTarget.value)
              }
            />
          </label>
        </TabsContent>
        <TabsContent value="monogram" className="space-y-2">
          <Input
            aria-label={t("agents.monogram")}
            placeholder={t("agents.monogram")}
            value={letters}
            aria-invalid={!monogramPattern.test(letters)}
            onChange={(event) => {
              const text = event.target.value.normalize("NFKC").toUpperCase();
              setLetters(text);
              if (monogramPattern.test(text)) choose("monogram", text);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t("agents.monogramHint")}
          </p>
        </TabsContent>
      </Tabs>
      <ToggleGroup
        type="single"
        value={value?.color ?? ""}
        onValueChange={(color) => {
          if (color) onChange({ kind: "monogram", value: "", ...value, color });
        }}
        spacing={1}
        className="grid w-full grid-cols-8"
        aria-label={t("agents.avatarColor")}
      >
        {Object.entries(avatarPalette).map(([color, style]) => {
          const label = t(`agents.color.${color}`);
          return (
            <ToggleGroupItem
              key={color}
              value={color}
              aria-label={label}
              title={label}
              className="min-w-0 px-0"
            >
              <span
                aria-hidden="true"
                className="grid size-5 place-items-center rounded-full"
                data-avatar-color={color}
                style={style}
              >
                {value?.color === color && (
                  <Check className="size-3" strokeWidth={2.5} />
                )}
              </span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={() => {
          onChange(defaultAvatar);
          setMode(defaultAvatar.kind);
          setCustom("");
          setLetters("");
          setQuery("");
        }}
      >
        {t("agents.defaultAvatar")}
      </Button>
    </div>
  );
}
