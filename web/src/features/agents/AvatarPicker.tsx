import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ImagePlus, LoaderCircle, SmilePlus, Upload } from "lucide-react";
import type { Agent, Avatar } from "@/api/types.gen";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar, avatarImageSrc } from "./AgentAvatar";
import { avatarPalette, defaultAvatar } from "./avatarPalette";
import { avatarIconNames, popularAvatarIcons } from "./avatarIcons";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_DIMENSION = 512;
const DIRECT_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

class AvatarImageError extends Error {
  readonly code: "invalid" | "tooLarge";
  constructor(code: "invalid" | "tooLarge") {
    super(code);
    this.code = code;
  }
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new AvatarImageError("invalid"));
    };
    img.src = url;
  });
}

async function prepareAvatarImage(file: File): Promise<File> {
  if (file.size === 0) throw new AvatarImageError("invalid");
  if (file.type === "image/gif") {
    if (file.size > MAX_AVATAR_BYTES) throw new AvatarImageError("tooLarge");
    return file;
  }
  const img = await loadImageElement(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width <= 0 || height <= 0) throw new AvatarImageError("invalid");
  if (
    DIRECT_AVATAR_TYPES.has(file.type) &&
    file.size <= MAX_AVATAR_BYTES &&
    Math.max(width, height) <= MAX_AVATAR_DIMENSION
  ) {
    return file;
  }
  const sourceSide = Math.min(width, height);
  const sx = (width - sourceSide) / 2;
  const sy = (height - sourceSide) / 2;
  const targetSide =
    file.type === "image/svg+xml"
      ? MAX_AVATAR_DIMENSION
      : Math.min(MAX_AVATAR_DIMENSION, sourceSide);
  const canvas = document.createElement("canvas");
  canvas.width = targetSide;
  canvas.height = targetSide;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if (DIRECT_AVATAR_TYPES.has(file.type) && file.size <= MAX_AVATAR_BYTES)
      return file;
    throw new AvatarImageError("invalid");
  }
  ctx.drawImage(
    img,
    sx,
    sy,
    sourceSide,
    sourceSide,
    0,
    0,
    targetSide,
    targetSide,
  );
  const outputType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      outputType,
      outputType === "image/jpeg" ? 0.9 : undefined,
    ),
  );
  if (!blob || blob.size === 0 || blob.size > MAX_AVATAR_BYTES) {
    if (DIRECT_AVATAR_TYPES.has(file.type) && file.size <= MAX_AVATAR_BYTES)
      return file;
    throw new AvatarImageError(
      blob && blob.size > MAX_AVATAR_BYTES ? "tooLarge" : "invalid",
    );
  }
  return new File([blob], outputType === "image/jpeg" ? "avatar.jpg" : "avatar.png", {
    type: outputType,
  });
}

function pickerMode(kind?: string) {
  if (kind === "preset") return "image";
  if (
    kind === "emoji" ||
    kind === "lucide" ||
    kind === "monogram" ||
    kind === "image"
  ) {
    return kind;
  }
  return defaultAvatar.kind;
}

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
  const [mode, setMode] = useState(() => pickerMode(value?.kind));
  const [pickedColor, setPickedColor] = useState(
    () => value?.color || defaultAvatar.color,
  );
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(() =>
    value?.kind === "emoji" && !emojis.includes(value.value)
      ? firstGrapheme(value.value)
      : "",
  );
  const [letters, setLetters] = useState(
    value?.kind === "monogram" ? value.value : "",
  );
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const hasImageAvatar = !!avatarImageSrc(value);
  const usesColor = value?.kind !== "image" && value?.kind !== "preset";
  const normalized = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = normalized
    ? avatarIconNames
        .filter((name) => name.toLowerCase().includes(normalized))
        .slice(0, 60)
    : popularAvatarIcons;
  const iconColor = (usesColor ? value?.color : undefined) || pickedColor;
  const choose = (kind: string, text: string) =>
    onChange({
      kind,
      value: text,
      color: usesColor ? value?.color : pickedColor,
    });
  const editCustomEmoji = (text: string) => {
    const grapheme = firstGrapheme(text);
    setCustom(grapheme);
    if (isEmoji(grapheme)) choose("emoji", grapheme);
  };
  const uploadImage = async (file: File) => {
    const seq = ++uploadSeq.current;
    setUploadError("");
    setUploading(true);
    try {
      const prepared = await prepareAvatarImage(file);
      const form = new FormData();
      form.append("file", prepared);
      const uploaded = await api<Avatar>("/avatars", form);
      if (!mounted.current || uploadSeq.current !== seq) return;
      onChange(uploaded);
    } catch (error) {
      if (!mounted.current || uploadSeq.current !== seq) return;
      if (error instanceof AvatarImageError) {
        setUploadError(
          t(
            error.code === "tooLarge"
              ? "agents.avatarImageTooLarge"
              : "agents.avatarImageInvalid",
          ),
        );
      } else if (error instanceof Error && error.message) {
        setUploadError(error.message);
      } else {
        setUploadError(t("agents.avatarImageUploadFailed"));
      }
    } finally {
      if (mounted.current && uploadSeq.current === seq) {
        setUploading(false);
      }
    }
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
          <TabsTrigger value="image">
            {t("agents.avatarType.image")}
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
        <TabsContent
          value="image"
          className="space-y-2"
          onPaste={(event) => {
            if (uploading) return;
            const file = Array.from(event.clipboardData.items)
              .find(
                (item) => item.kind === "file" && item.type.startsWith("image/"),
              )
              ?.getAsFile();
            if (file) {
              event.preventDefault();
              void uploadImage(file);
            }
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-label={t("agents.uploadAvatar")}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void uploadImage(file);
            }}
          />
          <button
            type="button"
            className="avatar-upload-zone"
            data-dragging={dragging || undefined}
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              if (uploading || !event.dataTransfer.types.includes("Files"))
                return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                setDragging(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (uploading) return;
              const file = event.dataTransfer.files[0];
              if (file) void uploadImage(file);
            }}
          >
            {hasImageAvatar ? (
              <AgentAvatar agent={agent} />
            ) : (
              <span
                className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground"
                aria-hidden="true"
              >
                <ImagePlus className="size-5" />
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 text-[length:var(--text-control)] font-medium">
              {uploading ? (
                <>
                  <LoaderCircle
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  {t("agents.uploadingAvatar")}
                </>
              ) : (
                <>
                  <Upload className="size-3.5" aria-hidden="true" />
                  {t(
                    hasImageAvatar
                      ? "agents.replaceAvatarImage"
                      : "agents.uploadAvatar",
                  )}
                </>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("agents.uploadAvatarHint")}
            </span>
          </button>
          {uploadError && (
            <p role="alert" className="text-xs text-destructive">
              {uploadError}
            </p>
          )}
        </TabsContent>
      </Tabs>
      {mode !== "image" && (
        <ToggleGroup
          type="single"
          value={usesColor ? (value?.color ?? "") : pickedColor}
          onValueChange={(color) => {
            if (!color) return;
            setPickedColor(color);
            if (usesColor) {
              onChange({ kind: "monogram", value: "", ...value, color });
            } else if (mode === "monogram") {
              onChange({ kind: "monogram", value: letters, color });
            }
          }}
          spacing={1}
          className="grid w-full grid-cols-8"
          aria-label={t("agents.avatarColor")}
        >
          {Object.entries(avatarPalette).map(([color, style]) => {
            const label = t(`agents.color.${color}`);
            const selectedColor = usesColor
              ? value?.color === color
              : pickedColor === color;
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
                  {selectedColor && (
                    <Check className="size-3" strokeWidth={2.5} />
                  )}
                </span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      )}
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={() => {
          onChange(defaultAvatar);
          setMode(defaultAvatar.kind);
          setPickedColor(defaultAvatar.color);
          setCustom("");
          setLetters("");
          setQuery("");
          setUploadError("");
        }}
      >
        {t("agents.defaultAvatar")}
      </Button>
    </div>
  );
}
