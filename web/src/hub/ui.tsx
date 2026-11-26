import type { CSSProperties } from "react";
import { Laptop, Server, Smartphone } from "lucide-react";
import { avatarPalette } from "@/features/agents/avatarPalette";
import leverAppIcon from "../../../mobile/icon.png";

const GRADIENT_KEYS = Object.keys(avatarPalette).filter((k) =>
  k.startsWith("gradient-"),
) as (keyof typeof avatarPalette)[];

function hashString(input: string) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function agentInitials(name?: string) {
  const clean = (name ?? "").trim();
  if (!clean) return "AG";
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (
      Array.from(parts[0])[0] + Array.from(parts[1])[0]
    ).toUpperCase();
  }
  return Array.from(clean).slice(0, 2).join("").toUpperCase();
}

export function HubAgentAvatar({
  id,
  name,
  avatar,
  size = "md",
}: {
  id: string;
  name?: string;
  avatar?: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const key = GRADIENT_KEYS[hashString(id || name || "lever") % GRADIENT_KEYS.length];
  const paletteStyle = avatarPalette[key] as CSSProperties;
  const dims =
    size === "xs"
      ? "size-5 rounded-[5px] text-[10px]"
      : size === "sm"
        ? "size-7 rounded-[7px] text-[11px]"
        : size === "lg"
          ? "size-12 rounded-[11px] text-[17px]"
          : "size-11 rounded-[10px] text-[15px]";
  const display = avatar?.trim() || agentInitials(name);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center font-semibold tracking-tight text-[#141418] select-none ${dims}`}
      style={paletteStyle}
      aria-hidden="true"
    >
      {display}
    </span>
  );
}

export function HubDeviceIcon({
  platform,
  role,
  className = "size-4",
}: {
  platform?: string;
  role?: string;
  className?: string;
}) {
  const p = (platform ?? "").toLowerCase();
  if (p === "ios" || p === "android" || role === "controller") {
    return <Smartphone className={className} />;
  }
  if (p === "linux" && role === "executor") {
    return <Server className={className} />;
  }
  return <Laptop className={className} />;
}

export function LeverMark({ size = 56 }: { size?: number }) {
  const radius = Math.round(size * 0.225);
  return (
    <img
      src={leverAppIcon}
      alt="Lever"
      width={size}
      height={size}
      draggable={false}
      style={{ borderRadius: radius }}
      className="shrink-0 object-cover shadow-sm select-none"
    />
  );
}

export function roleLabel(role?: string) {
  switch (role) {
    case "workstation":
      return "工作机";
    case "executor":
      return "仅执行";
    case "controller":
      return "控制端";
    default:
      return role ?? "";
  }
}

export function formatChatTime(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${hh}:${mm}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
